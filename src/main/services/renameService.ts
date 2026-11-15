import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EXCLUDED_PATHS, SYSTEM_EXCLUDED_DIR_NAMES } from '@shared/constants';
import { localOrganizePath } from '@shared/organize';
import {
  applyRenameRules,
  validateRenameName,
  RENAME_ITEM_LIMIT,
  type RenameItem,
  type RenamePreview,
  type RenamePreviewItem,
  type RenamePreviewRequest,
  type RenameState,
  type RenameUndoInfo,
} from '@shared/rename';
import { getActiveScanId } from '../db/scansRepo';
import {
  appendRenameUndoItem,
  countRemainingUndo,
  createRenameBatch,
  finishRenameBatch,
  getUndoBatch,
  invalidateDuplicateResults,
  listUndoItems,
  pruneRenameBatches,
  recoverRenameBatches,
  setUndoItemStatus,
  syncRenamedFile,
  syncRenamedFolder,
} from '../db/renameRepo';
import {
  assertFolderUnchanged,
  assertUnchanged,
  organizeAttributeError,
} from './organizeCore';
import {
  getDriveLetter,
  isSameOrSubPath,
  normalizePathKey,
  safeLstat,
  stripExtendedPath,
  toExtendedPath,
} from './filesystem';
import { moveFileNoReplace, readFileAttributes } from './windowsService';

export interface RenameServiceDeps {
  db: DatabaseSync;
  fixedDrives(): Set<string>;
  protectedPaths: string[];
  isBusy(): boolean;
}

interface PreparedEntry {
  request: RenameItem;
  item: RenamePreviewItem;
  source: string;
  parentDir: string;
  before: fs.Stats;
}

interface PendingPlan {
  token: string;
  scanId: number | null;
  entries: PreparedEntry[];
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function sameKey(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function caseOnlyNameChange(source: string, target: string): boolean {
  return sameKey(source, target) && source !== target;
}

export class RenameService {
  private plan: PendingPlan | null = null;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private planning = false;
  private state: RenameState = {
    status: 'idle',
    mode: null,
    total: 0,
    processed: 0,
    currentPath: '',
    results: [],
    startedAt: null,
    finishedAt: null,
  };

  constructor(private readonly deps: RenameServiceDeps) {}

  recover(): void {
    recoverRenameBatches(this.deps.db);
  }

  getState(): RenameState {
    return structuredClone(this.state);
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  cancel(): RenameState {
    if (this.controller) {
      this.state.status = 'cancelling';
      this.controller.abort();
    }
    return this.getState();
  }

  getUndoInfo(): RenameUndoInfo | null {
    const batch = getUndoBatch(this.deps.db);
    return batch ? { count: batch.count, createdAt: batch.createdAt } : null;
  }

  inspectPaths(paths: string[]): Array<{ path: string; kind: 'file' | 'folder' }> {
    const seen = new Set<string>();
    const items: Array<{ path: string; kind: 'file' | 'folder' }> = [];
    for (const raw of paths) {
      const key = normalizePathKey(raw).replace(/\\+$/, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        const stat = fs.lstatSync(toExtendedPath(raw));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
        items.push({ path: raw, kind: stat.isDirectory() ? 'folder' : 'file' });
        if (items.length >= RENAME_ITEM_LIMIT) break;
      } catch {
        // 拖入时已消失的项目不加入列表。
      }
    }
    return items;
  }

  private ensureIdle(label: string): void {
    if (this.isRunning()) throw new Error(`重命名任务进行中，请完成或停止后再${label}`);
    if (this.deps.isBusy()) throw new Error(`请等待其他扫描、整理或删除任务结束后再${label}`);
  }

  private criticalPaths(): string[] {
    const drive = (process.env.SystemDrive ?? 'C:').replace(/\\+$/, '');
    return [`${drive}\\Users`];
  }

  private local(value: string, kind: 'file' | 'folder'): string {
    localOrganizePath.parse(value);
    if (!this.deps.fixedDrives().has(getDriveLetter(value)))
      throw new Error('只支持可用的本地固定硬盘');
    const resolved = stripExtendedPath(fs.realpathSync.native(toExtendedPath(value)));
    if (normalizePathKey(resolved) !== normalizePathKey(value))
      throw new Error('不支持链接、快捷方式或重定向路径');
    if (path.win32.basename(resolved) === '') throw new Error('不能重命名硬盘根目录');
    if (
      this.criticalPaths().some((entry) => sameKey(resolved, entry)) ||
      this.deps.protectedPaths.some((entry) => isSameOrSubPath(resolved, entry))
    ) {
      throw new Error('系统目录或软件目录不能参与重命名');
    }
    const segments = resolved.split(/[\\/]/).map((part) => part.toLowerCase());
    if (
      DEFAULT_EXCLUDED_PATHS.some((entry) => isSameOrSubPath(resolved, entry)) ||
      SYSTEM_EXCLUDED_DIR_NAMES.some((name) => segments.includes(name.toLowerCase()))
    ) {
      throw new Error('系统目录或回收区不能参与重命名');
    }
    const attributeError = organizeAttributeError(kind, readFileAttributes(resolved));
    if (attributeError) throw new Error(attributeError);
    return resolved;
  }

  async preview(input: RenamePreviewRequest): Promise<RenamePreview> {
    this.ensureIdle('生成预览');
    if (this.planning) throw new Error('正在生成预览，请稍候');
    this.planning = true;
    try {
      this.plan = null;
      const scanId = getActiveScanId(this.deps.db);
      const now = Date.now();
      const items: RenamePreviewItem[] = [];
      const entries: PreparedEntry[] = [];
      const seen = new Set<string>();
      const folderKeys = input.items
        .filter((item) => item.kind === 'folder')
        .map((item) => normalizePathKey(item.path).replace(/\\+$/, ''));
      let sequence = 0;
      const reserved = new Set<string>();
      const reasons = input.rules.filter((rule) => rule.enabled);

      for (const request of input.items) {
        const rawKey = normalizePathKey(request.path).replace(/\\+$/, '');
        const rawName = path.win32.basename(request.path.replace(/\\+$/, ''));
        const previewItem: RenamePreviewItem = {
          path: request.path,
          kind: request.kind,
          name: rawName,
          newName: rawName,
          target: request.path,
          size: 0,
          status: 'blocked',
          message: '',
          notes: [],
        };
        items.push(previewItem);

        if (seen.has(rawKey)) {
          previewItem.status = 'skipped';
          previewItem.message = '列表中有重复项目，已跳过';
          continue;
        }
        seen.add(rawKey);
        const insideSelectedFolder = folderKeys.some(
          (folder) => folder !== rawKey && isSameOrSubPath(rawKey, folder),
        );
        if (insideSelectedFolder) {
          previewItem.status = 'skipped';
          previewItem.message = '所属文件夹也已加入列表，随文件夹一起重命名';
          continue;
        }

        try {
          const source = this.local(request.path, request.kind);
          const before = fs.lstatSync(toExtendedPath(source));
          previewItem.path = source;
          previewItem.name = path.win32.basename(source);
          previewItem.newName = previewItem.name;
          previewItem.target = source;
          previewItem.size = Math.max(0, before.size);
          if (request.kind === 'file' && (!before.isFile() || before.isSymbolicLink()))
            throw new Error('所选项目不是普通文件，请重新选择');
          if (request.kind === 'folder' && (!before.isDirectory() || before.isSymbolicLink()))
            throw new Error('所选项目不是普通文件夹，请重新选择');

          sequence += 1;
          const applied = applyRenameRules(previewItem.name, request.kind, reasons, {
            index: sequence,
            now,
            mtimeMs: before.mtimeMs,
          });
          previewItem.newName = applied.name;
          previewItem.notes = applied.notes;
          const target = path.join(path.win32.dirname(source), applied.name);
          previewItem.target = target;
          const nameError = validateRenameName(applied.name);
          if (nameError) throw new Error(nameError);
          if (applied.name === previewItem.name) {
            previewItem.status = 'unchanged';
            previewItem.message = '名称未变化，开始后将跳过';
            continue;
          }
          const sourceKey = normalizePathKey(source);
          const targetKey = normalizePathKey(target);
          if (reserved.has(targetKey)) throw new Error('与批量中的其他项目新名称重复');
          if (targetKey !== sourceKey && safeLstat(target))
            throw new Error('目标名称已存在，不会覆盖');
          reserved.add(targetKey);
          previewItem.status = 'ready';
          previewItem.message = '可以重命名';
          entries.push({
            request,
            item: previewItem,
            source,
            parentDir: path.win32.dirname(source),
            before,
          });
        } catch (error) {
          previewItem.status = 'blocked';
          previewItem.message = isMissingError(error)
            ? '文件或文件夹已不存在，请重新选择'
            : error instanceof Error
              ? error.message
              : String(error);
        }
      }

      const token = randomUUID();
      this.plan = { token, scanId, entries };
      return {
        token,
        items,
        readyCount: items.filter((item) => item.status === 'ready').length,
        unchangedCount: items.filter((item) => item.status === 'unchanged').length,
        skippedCount: items.filter((item) => item.status === 'skipped').length,
        blockedCount: items.filter((item) => item.status === 'blocked').length,
      };
    } finally {
      this.planning = false;
    }
  }

  start(token: string): RenameState {
    this.ensureIdle('开始重命名');
    const plan = this.plan;
    if (!plan || plan.token !== token || plan.scanId !== getActiveScanId(this.deps.db))
      throw new Error('预览已失效，请重新预览');
    if (plan.entries.length === 0) throw new Error('没有可重命名的项目');
    this.beginPlan(plan);
    return this.getState();
  }

  undo(): RenameState {
    this.ensureIdle('撤销重命名');
    const batch = getUndoBatch(this.deps.db);
    if (!batch) throw new Error('没有可撤销的重命名记录');
    this.plan = null;
    this.controller = new AbortController();
    this.state = {
      status: 'running',
      mode: 'undo',
      total: batch.count,
      processed: 0,
      currentPath: '',
      results: [],
      startedAt: Date.now(),
      finishedAt: null,
    };
    const signal = this.controller.signal;
    this.active = this.runUndo(batch.id, signal).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.getState();
  }

  private beginPlan(plan: PendingPlan): void {
    this.plan = null;
    this.controller = new AbortController();
    const batchId = createRenameBatch(this.deps.db, plan.entries.length);
    this.state = {
      status: 'running',
      mode: 'rename',
      total: plan.entries.length,
      processed: 0,
      currentPath: '',
      results: [],
      startedAt: Date.now(),
      finishedAt: null,
    };
    const signal = this.controller.signal;
    this.active = this.runRenames(plan.scanId, batchId, plan.entries, signal).finally(() => {
      this.active = null;
      this.controller = null;
    });
  }

  private async syncFileIndex(
    scanId: number | null,
    fileId: number | null,
    source: string,
    target: string,
  ): Promise<void> {
    if (scanId === null) return;
    syncRenamedFile(this.deps.db, scanId, fileId, source, target);
  }

  private async syncFolderIndex(
    scanId: number | null,
    source: string,
    target: string,
  ): Promise<void> {
    if (scanId === null) return;
    syncRenamedFolder(this.deps.db, scanId, source, target);
  }

  private async runRenames(
    scanId: number | null,
    batchId: number,
    entries: PreparedEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    let renamed = 0;
    for (const entry of entries) {
      await setImmediate();
      if (signal.aborted) break;
      this.state.currentPath = entry.source;
      let published = false;
      let warning = '';
      try {
        const source = this.local(entry.source, entry.request.kind);
        if (!sameKey(source, entry.source)) throw new Error('路径已变化，请重新预览');
        if (entry.request.kind === 'file') assertUnchanged(source, entry.before);
        else assertFolderUnchanged(source, entry.before);
        const target = path.join(entry.parentDir, entry.item.newName);
        const caseOnly = caseOnlyNameChange(source, target);
        if (!caseOnly && safeLstat(target)) throw new Error('目标名称已存在，不会覆盖');
        signal.throwIfAborted();
        if (caseOnly) {
          await fs.promises.rename(toExtendedPath(source), toExtendedPath(target));
        } else {
          moveFileNoReplace(source, target);
        }
        published = true;
        renamed += 1;
        try {
          appendRenameUndoItem(this.deps.db, batchId, entry.request.kind, source, target);
        } catch (error) {
          warning = `已重命名，但撤销记录写入失败：${error instanceof Error ? error.message : String(error)}`;
        }
        try {
          if (entry.request.kind === 'file') {
            await this.syncFileIndex(scanId, entry.request.fileId, source, target);
          } else {
            await this.syncFolderIndex(scanId, source, target);
          }
        } catch (error) {
          warning = `已重命名，但索引同步失败，请重新扫描：${error instanceof Error ? error.message : String(error)}`;
        }
        this.state.results.push({
          source,
          target,
          kind: entry.request.kind,
          status: 'renamed',
          message: warning || '重命名完成，可撤销本次整批操作',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state.results.push({
          source: entry.source,
          target: published ? entry.item.target : '',
          kind: entry.request.kind,
          status: signal.aborted ? 'cancelled' : published ? 'renamed' : 'failed',
          message: published ? `已重命名，但后续步骤失败：${reason}` : `未重命名，原名保留：${reason}`,
        });
      }
      this.state.processed += 1;
    }
    if (renamed > 0 && scanId !== null) {
      try {
        invalidateDuplicateResults(this.deps.db, scanId);
      } catch {
        // 索引仍已更新；重复结果会在下次同步或重新查找时刷新。
      }
    }
    try {
      finishRenameBatch(this.deps.db, batchId, signal.aborted ? 'cancelled' : 'completed');
    } catch {
      // 撤销记录文件由数据库维护；写入失败时不阻断任务结束提示。
    }
    if (renamed > 0) {
      try {
        pruneRenameBatches(this.deps.db, batchId);
      } catch {
        // 旧批次清理失败不影响本次撤销记录。
      }
    }
    this.state.currentPath = '';
    this.state.status = signal.aborted ? 'cancelled' : 'completed';
    this.state.finishedAt = Date.now();
  }

  private async runUndo(batchId: number, signal: AbortSignal): Promise<void> {
    const items = listUndoItems(this.deps.db, batchId);
    let restored = 0;
    const scanId = getActiveScanId(this.deps.db);
    for (const undo of items) {
      await setImmediate();
      if (signal.aborted) break;
      this.state.currentPath = undo.target;
      let published = false;
      try {
        const target = undo.target;
        const source = undo.source;
        if (!safeLstat(target)) throw new Error('已重命名项目不存在，可能已被移动或删除');
        const caseOnly = caseOnlyNameChange(target, source);
        if (!caseOnly && safeLstat(source)) throw new Error('原名称已被其他文件占用');
        signal.throwIfAborted();
        if (caseOnly) {
          await fs.promises.rename(toExtendedPath(target), toExtendedPath(source));
        } else {
          moveFileNoReplace(target, source);
        }
        published = true;
        restored += 1;
        let warning = '';
        try {
          if (undo.kind === 'file') {
            if (scanId !== null) syncRenamedFile(this.deps.db, scanId, null, target, source);
          } else if (scanId !== null) {
            syncRenamedFolder(this.deps.db, scanId, target, source);
          }
        } catch (error) {
          warning = `已还原原名，但索引同步失败，请重新扫描：${error instanceof Error ? error.message : String(error)}`;
        }
        try {
          setUndoItemStatus(this.deps.db, undo.id, 'restored', warning);
        } catch (error) {
          warning = `已还原原名，但撤销记录更新失败：${error instanceof Error ? error.message : String(error)}`;
        }
        this.state.results.push({
          source: target,
          target: source,
          kind: undo.kind,
          status: 'restored',
          message: warning || '已还原为原名',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state.results.push({
          source: undo.target,
          target: published ? undo.source : '',
          kind: undo.kind,
          status: published ? 'restored' : signal.aborted ? 'cancelled' : 'failed',
          message: published ? `已还原原名，但后续步骤失败：${reason}` : `未还原：${reason}`,
        });
      }
      this.state.processed += 1;
    }
    if (restored > 0 && scanId !== null) {
      try {
        invalidateDuplicateResults(this.deps.db, scanId);
      } catch {
        // 撤销已完成；重复结果会在下次同步或重新查找时刷新。
      }
    }
    try {
      if (countRemainingUndo(this.deps.db, batchId) === 0) {
        finishRenameBatch(this.deps.db, batchId, 'undone');
      }
    } catch {
      // 撤销记录状态更新失败不影响磁盘结果。
    }
    this.state.currentPath = '';
    this.state.status = signal.aborted ? 'cancelled' : 'completed';
    this.state.finishedAt = Date.now();
  }
}
