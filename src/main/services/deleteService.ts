import type { DatabaseSync } from 'node:sqlite';
import fs, { lstatSync } from 'node:fs';
import path from 'node:path';
import type {
  DeleteEvent,
  DeleteFailure,
  DeletePreview,
  DeleteProgress,
  DeleteResult,
  RecycleStatus,
} from '@shared/types';
import { evaluateRecycleDecision, type RecycleBinPolicy } from './recycleBinService';
import { LONG_PATH_LIMIT, LONG_TRASH_DIR_NAME } from './longTrashService';
import { getDriveLetter, isSameOrSubPath, toExtendedPath } from './filesystem';
import {
  applyDeletedFileRows,
  applyDeletedFolders,
  folderStats,
  listDeleteFileRows,
} from '../db/deleteRepo';
import { getActiveScanId } from '../db/scansRepo';
import { readFileAttributes } from './windowsService';

interface PlannedFile {
  id: number;
  drive: string;
  path: string;
  path_key: string;
  name: string;
  size: number;
  status: 'ok' | 'longPath' | 'missing' | 'trashUnavailable' | 'tooLarge';
  message: string | null;
}

interface PlannedFolder {
  path: string;
  name: string;
  bytes: number;
  fileCount: number;
  status: 'ok' | 'missing' | 'blocked' | 'trashUnavailable' | 'tooLarge';
  message: string | null;
}

export interface LongTrashPort {
  needsQuarantine(filePath: string): boolean;
  quarantine(filePath: string, meta?: { size?: number; name?: string }): Promise<unknown>;
}

export interface DeleteServiceDeps {
  db: DatabaseSync;
  getRecyclePolicy: (driveRoot: string) => RecycleBinPolicy;
  trashItem: (path: string) => Promise<void>;
  longTrash?: LongTrashPort;
  emit?: (event: DeleteEvent) => void;
  now?: () => number;
  concurrency?: number;
}

type WorkItem = { kind: 'file'; file: PlannedFile } | { kind: 'folder'; folder: PlannedFolder };

const PREVIEW_NAME_LIMIT = 5;

function idleState(): DeleteProgress {
  return {
    status: 'idle',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    bytes: 0,
    quarantined: 0,
    foldersSucceeded: 0,
    folderFileCount: 0,
    folderBytes: 0,
    currentPath: '',
    startedAt: null,
    finishedAt: null,
    result: null,
  };
}

function fileExists(filePath: string): boolean {
  try {
    const stats = lstatSync(toExtendedPath(filePath), { throwIfNoEntry: false });
    return Boolean(stats);
  } catch {
    return false;
  }
}

function describeTrashError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return '移到回收站失败';
  if (/ENOENT|找不到|not found|does not exist/i.test(message)) return '文件已不存在';
  if (/EBUSY|EPERM|EACCES|占用|拒绝访问|access is denied/i.test(message)) {
    return '文件被占用或没有权限';
  }
  return message;
}

function normalizeFolder(input: string): string {
  const trimmed = input.trim().replace(/\//g, '\\');
  if (/^[A-Za-z]:\\?$/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.replace(/\\+$/, '');
}

function isDriveRoot(folderPath: string): boolean {
  return /^[A-Za-z]:\\?$/.test(folderPath);
}

export class DeleteService {
  private readonly db: DatabaseSync;
  private readonly getRecyclePolicy: (driveRoot: string) => RecycleBinPolicy;
  private readonly trashItem: (path: string) => Promise<void>;
  private readonly longTrash: LongTrashPort | undefined;
  private readonly emitEvent: ((event: DeleteEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly concurrency: number;

  private state: DeleteProgress = idleState();
  private active: Promise<void> | null = null;
  private stopRequested = false;

  constructor(deps: DeleteServiceDeps) {
    this.db = deps.db;
    this.getRecyclePolicy = deps.getRecyclePolicy;
    this.trashItem = deps.trashItem;
    this.longTrash = deps.longTrash;
    this.emitEvent = deps.emit;
    this.now = deps.now ?? Date.now;
    this.concurrency = Math.max(1, Math.min(4, deps.concurrency ?? 2));
  }

  getState(): DeleteProgress {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  cancel(): DeleteProgress {
    if (this.state.status === 'running') {
      this.stopRequested = true;
      this.state = {
        ...this.state,
        currentPath: '',
      };
      this.emit();
    }
    return this.state;
  }

  status(): RecycleStatus {
    const scanId = getActiveScanId(this.db);
    const driveLetters =
      scanId === null
        ? []
        : (
            this.db
              .prepare('SELECT DISTINCT drive FROM files WHERE scan_id = ? ORDER BY drive')
              .all(scanId) as Array<{ drive: string }>
          ).map((row) => row.drive);
    const drives = driveLetters.map((drive) => {
      const policy = this.getRecyclePolicy(`${drive}\\`);
      return {
        drive,
        available: policy.available,
        reason: policy.available ? null : 'Windows 回收站当前不可用，删除功能已暂停',
        maxCapacityBytes: policy.maxCapacityBytes,
      };
    });
    const unavailable = drives.filter((item) => !item.available);
    return {
      available: unavailable.length === 0,
      reason:
        unavailable.length === 0
          ? null
          : `${unavailable.map((item) => item.drive).join('、')} 的回收站当前不可用，删除功能已暂停`,
      drives,
    };
  }

  private activeScanId(): number {
    const scanId = getActiveScanId(this.db);
    if (scanId === null) throw new Error('还没有可用的扫描索引，请先扫描硬盘');
    return scanId;
  }

  private planFolders(
    folderPaths: string[],
    scanId: number,
    policies: Map<string, RecycleBinPolicy>,
    usedByDrive: Map<string, number>,
  ): PlannedFolder[] {
    const unique = [...new Set(folderPaths.map(normalizeFolder).filter(Boolean))];
    const sorted = unique.sort((a, b) => a.length - b.length);
    const kept: string[] = [];
    for (const folder of sorted) {
      if (kept.some((parent) => isSameOrSubPath(folder, parent))) continue;
      kept.push(folder);
    }
    return kept.map((folder) => this.planFolder(folder, scanId, policies, usedByDrive));
  }

  private planFolder(
    folderPath: string,
    scanId: number,
    policies: Map<string, RecycleBinPolicy>,
    usedByDrive: Map<string, number>,
  ): PlannedFolder {
    const name = path.win32.basename(folderPath) || folderPath;
    const blocked = (status: PlannedFolder['status'], message: string): PlannedFolder => ({
      path: folderPath,
      name,
      bytes: 0,
      fileCount: 0,
      status,
      message,
    });

    if (isDriveRoot(folderPath)) return blocked('blocked', '不能删除盘符根目录');
    const segments = folderPath.split(/[\\/]/).map((segment) => segment.toLowerCase());
    if (segments.includes(LONG_TRASH_DIR_NAME)) {
      return blocked('blocked', '不能删除软件的回收区目录');
    }
    if (folderPath.length >= LONG_PATH_LIMIT) {
      return blocked('blocked', '文件夹路径超过 Windows 回收站支持的 260 字符，无法安全删除');
    }

    let stats: fs.Stats | null = null;
    try {
      stats = lstatSync(toExtendedPath(folderPath), { throwIfNoEntry: false }) ?? null;
    } catch {
      stats = null;
    }
    if (!stats) return blocked('missing', '文件夹已不存在，可能已被移动或删除');
    if (stats.isSymbolicLink()) return blocked('blocked', '不能删除链接或重解析点');
    if (readFileAttributes(folderPath)?.reparsePoint) {
      return blocked('blocked', '不能删除链接或重解析点');
    }
    if (!stats.isDirectory()) return blocked('blocked', '目标不是文件夹');

    const { bytes, count } = folderStats(this.db, scanId, folderPath);
    if (count === 0) return blocked('missing', '索引中没有该文件夹的文件，请重新扫描后再试');

    const driveRoot = `${getDriveLetter(folderPath)}\\`;
    let policy = policies.get(driveRoot);
    if (!policy) {
      policy = this.getRecyclePolicy(driveRoot);
      policies.set(driveRoot, policy);
    }
    const driveUsed = usedByDrive.get(driveRoot) ?? 0;
    const decision = evaluateRecycleDecision(policy, bytes, driveUsed);
    if (!decision.allowed) {
      return blocked(
        decision.reason === 'too-large' ? 'tooLarge' : 'trashUnavailable',
        decision.message ?? '无法保证文件夹可还原',
      );
    }
    usedByDrive.set(driveRoot, driveUsed + bytes);
    return { path: folderPath, name, bytes, fileCount: count, status: 'ok', message: null };
  }

  private planFiles(
    fileIds: number[],
    folderPaths: string[],
    scanId: number,
    policies: Map<string, RecycleBinPolicy>,
    usedByDrive: Map<string, number>,
  ): PlannedFile[] {
    const unique = [...new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return [];
    const rows = listDeleteFileRows(this.db, scanId, unique);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const folderKeys = folderPaths.map((folder) => folder.toLowerCase());
    const planned: PlannedFile[] = [];

    for (const id of unique) {
      const row = byId.get(id);
      if (!row) {
        planned.push({
          id,
          drive: '',
          path: '',
          path_key: '',
          name: `#${id}`,
          size: 0,
          status: 'missing',
          message: '文件不在当前索引中，请重新扫描后再试',
        });
        continue;
      }
      if (folderKeys.some((folder) => isSameOrSubPath(row.path, folder))) continue;
      if (!fileExists(row.path)) {
        planned.push({ ...row, status: 'missing', message: '文件已不存在，可能已被移动或删除' });
        continue;
      }
      if (row.path.length >= LONG_PATH_LIMIT) {
        if (this.longTrash?.needsQuarantine(row.path)) {
          planned.push({
            ...row,
            status: 'longPath',
            message: '路径超过 Windows 回收站支持的 260 字符，将移入软件回收区',
          });
        } else {
          planned.push({
            ...row,
            status: 'trashUnavailable',
            message: '路径超过 Windows 回收站支持的 260 字符，当前无法安全删除',
          });
        }
        continue;
      }
      const driveRoot = `${getDriveLetter(row.path) || row.drive}\\`;
      let policy = policies.get(driveRoot);
      if (!policy) {
        policy = this.getRecyclePolicy(driveRoot);
        policies.set(driveRoot, policy);
      }
      const driveUsed = usedByDrive.get(driveRoot) ?? 0;
      const decision = evaluateRecycleDecision(policy, row.size, driveUsed);
      if (!decision.allowed) {
        planned.push({
          ...row,
          status: decision.reason === 'too-large' ? 'tooLarge' : 'trashUnavailable',
          message: decision.message,
        });
        continue;
      }
      usedByDrive.set(driveRoot, driveUsed + row.size);
      planned.push({ ...row, status: 'ok', message: null });
    }
    return planned;
  }

  private plan(
    fileIds: number[],
    folderPaths: string[],
  ): { files: PlannedFile[]; folders: PlannedFolder[] } {
    const scanId = this.activeScanId();
    const policies = new Map<string, RecycleBinPolicy>();
    const usedByDrive = new Map<string, number>();
    const folders = this.planFolders(folderPaths, scanId, policies, usedByDrive);
    const deletableFolders = folders
      .filter((folder) => folder.status === 'ok')
      .map((folder) => folder.path);
    const files = this.planFiles(fileIds, deletableFolders, scanId, policies, usedByDrive);
    return { files, folders };
  }

  preview(fileIds: number[], folderPaths: string[] = []): DeletePreview {
    const { files, folders } = this.plan(fileIds, folderPaths);
    const okFiles = files.filter((item) => item.status === 'ok');
    const longPathFiles = files.filter((item) => item.status === 'longPath');
    const missingFiles = files.filter((item) => item.status === 'missing');
    const blockedFiles = files.filter(
      (item) => item.status === 'trashUnavailable' || item.status === 'tooLarge',
    );
    const okFolders = folders.filter((item) => item.status === 'ok');
    const missingFolders = folders.filter((item) => item.status === 'missing');
    const blockedFolders = folders.filter(
      (item) =>
        item.status === 'blocked' ||
        item.status === 'trashUnavailable' ||
        item.status === 'tooLarge',
    );
    const recycleBlocked = [...blockedFiles, ...blockedFolders].filter(
      (item) => item.status === 'trashUnavailable',
    );
    const folderNames = okFolders.slice(0, PREVIEW_NAME_LIMIT).map((item) => item.name);
    const fileNames = [...okFiles, ...longPathFiles]
      .slice(0, PREVIEW_NAME_LIMIT)
      .map((item) => item.name);
    return {
      total: files.length + folders.length,
      okCount: okFiles.length,
      okBytes: okFiles.reduce((sum, item) => sum + item.size, 0),
      longPathCount: longPathFiles.length,
      longPathBytes: longPathFiles.reduce((sum, item) => sum + item.size, 0),
      missingCount: missingFiles.length + missingFolders.length,
      blockedCount: blockedFiles.length + blockedFolders.length,
      previewNames: [...folderNames, ...fileNames].slice(0, PREVIEW_NAME_LIMIT),
      folderOkCount: okFolders.length,
      folderOkFileCount: okFolders.reduce((sum, item) => sum + item.fileCount, 0),
      folderOkBytes: okFolders.reduce((sum, item) => sum + item.bytes, 0),
      folderNames,
      fileNames,
      blockedMessage: blockedFolders[0]?.message ?? null,
      recycleAvailable: recycleBlocked.length === 0,
      recycleMessage:
        recycleBlocked.length === 0
          ? null
          : (recycleBlocked[0].message ?? 'Windows 回收站当前不可用，删除功能已暂停'),
      canDelete: okFiles.length + longPathFiles.length + okFolders.length > 0,
    };
  }

  start(fileIds: number[], folderPaths: string[] = []): DeleteProgress {
    if (this.isRunning()) throw new Error('删除正在进行，请等待完成或先停止');
    this.stopRequested = false;
    const { files, folders } = this.plan(fileIds, folderPaths);
    const failures: DeleteFailure[] = [];
    for (const item of folders) {
      if (item.status === 'ok') continue;
      failures.push({
        fileId: 0,
        path: item.path,
        name: item.name,
        reason: item.message ?? '无法移到回收站',
        kind: 'folder',
      });
    }
    for (const item of files) {
      if (item.status === 'ok' || item.status === 'longPath') continue;
      failures.push({
        fileId: item.id,
        path: item.path,
        name: item.name,
        reason: item.message ?? '无法移到回收站',
        kind: 'file',
      });
    }
    const okFolders = folders.filter((item) => item.status === 'ok');
    const okFiles = files.filter((item) => item.status === 'ok' || item.status === 'longPath');
    const work: WorkItem[] = [
      ...okFolders.map((folder): WorkItem => ({ kind: 'folder', folder })),
      ...okFiles.map((file): WorkItem => ({ kind: 'file', file })),
    ];
    const startedAt = this.now();
    this.state = {
      status: 'running',
      total: work.length,
      processed: 0,
      succeeded: 0,
      failed: failures.length,
      bytes: 0,
      quarantined: 0,
      foldersSucceeded: 0,
      folderFileCount: 0,
      folderBytes: 0,
      currentPath: '',
      startedAt,
      finishedAt: null,
      result: null,
    };
    this.emit();
    this.active = this.run(work, failures).finally(() => {
      this.active = null;
    });
    return this.state;
  }

  private async run(work: WorkItem[], failures: DeleteFailure[]): Promise<void> {
    const succeededFiles: PlannedFile[] = [];
    const succeededFolders: PlannedFolder[] = [];
    const quarantinedRows: PlannedFile[] = [];
    let processed = 0;
    let index = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopRequested) return;
        const current = index;
        index += 1;
        if (current >= work.length) return;
        const item = work[current];
        const itemPath = item.kind === 'folder' ? item.folder.path : item.file.path;
        this.state = { ...this.state, currentPath: itemPath };
        try {
          if (item.kind === 'folder') {
            await this.trashItem(item.folder.path);
            succeededFolders.push(item.folder);
            this.state = {
              ...this.state,
              succeeded: succeededFolders.length + succeededFiles.length,
              bytes: this.state.bytes + item.folder.bytes,
              foldersSucceeded: succeededFolders.length,
              folderFileCount: this.state.folderFileCount + item.folder.fileCount,
              folderBytes: this.state.folderBytes + item.folder.bytes,
            };
          } else if (item.file.status === 'longPath') {
            if (!this.longTrash) throw new Error('长路径回收区不可用');
            await this.longTrash.quarantine(item.file.path, {
              size: item.file.size,
              name: item.file.name,
            });
            quarantinedRows.push(item.file);
            succeededFiles.push(item.file);
            this.state = {
              ...this.state,
              succeeded: succeededFolders.length + succeededFiles.length,
              bytes: this.state.bytes + item.file.size,
              quarantined: quarantinedRows.length,
            };
          } else {
            await this.trashItem(item.file.path);
            succeededFiles.push(item.file);
            this.state = {
              ...this.state,
              succeeded: succeededFolders.length + succeededFiles.length,
              bytes: this.state.bytes + item.file.size,
            };
          }
        } catch (error) {
          failures.push(
            item.kind === 'folder'
              ? {
                  fileId: 0,
                  path: item.folder.path,
                  name: item.folder.name,
                  reason: describeTrashError(error),
                  kind: 'folder',
                }
              : {
                  fileId: item.file.id,
                  path: item.file.path,
                  name: item.file.name,
                  reason: describeTrashError(error),
                  kind: 'file',
                },
          );
          this.state = { ...this.state, failed: failures.length };
        }
        processed += 1;
        this.state = { ...this.state, processed };
        this.emit();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, Math.max(1, work.length)) }, () => worker()),
    );

    const scanId = getActiveScanId(this.db);
    if (scanId !== null) {
      try {
        if (succeededFiles.length > 0) {
          applyDeletedFileRows(this.db, scanId, succeededFiles);
        }
        if (succeededFolders.length > 0) {
          applyDeletedFolders(
            this.db,
            scanId,
            succeededFolders.map((folder) => folder.path),
          );
        }
      } catch (error) {
        failures.push({
          fileId: 0,
          path: '',
          name: '',
          reason: `文件已移出原位置，但更新索引失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const result: DeleteResult = {
      succeeded: succeededFolders.length + succeededFiles.length,
      failed: failures.length,
      bytes:
        succeededFolders.reduce((sum, folder) => sum + folder.bytes, 0) +
        succeededFiles.reduce((sum, file) => sum + file.size, 0),
      quarantined: quarantinedRows.length,
      quarantineBytes: quarantinedRows.reduce((sum, file) => sum + file.size, 0),
      foldersSucceeded: succeededFolders.length,
      folderFileCount: succeededFolders.reduce((sum, folder) => sum + folder.fileCount, 0),
      folderBytes: succeededFolders.reduce((sum, folder) => sum + folder.bytes, 0),
      failures,
      stopped: this.stopRequested,
    };
    this.state = {
      ...this.state,
      status: 'completed',
      processed: work.length,
      succeeded: result.succeeded,
      failed: result.failed,
      bytes: result.bytes,
      quarantined: result.quarantined,
      foldersSucceeded: result.foldersSucceeded,
      folderFileCount: result.folderFileCount,
      folderBytes: result.folderBytes,
      currentPath: '',
      finishedAt: this.now(),
      result,
    };
    this.emitEvent?.({ type: 'settled', state: this.state, result });
  }

  private emit(): void {
    this.emitEvent?.({ type: 'state', state: this.state });
  }
}
