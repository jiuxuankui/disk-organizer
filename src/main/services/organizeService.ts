import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FileRecord } from '@shared/types';
import type {
  OrganizeItem,
  OrganizePreview,
  OrganizePreviewRequest,
  OrganizeStartRequest,
  OrganizeState,
  SmartCategory,
  SmartOrganizePreviewRequest,
} from '@shared/organize';
import { SMART_CATEGORY_LABELS, smartCategoryOf } from '@shared/organize';
import { getActiveScanId } from '../db/scansRepo';
import { getFileById, getFilesByIds, listSourceFileIds } from '../db/filesRepo';
import { updateOrganizedFile } from '../db/organizeRepo';
import {
  assertUnchanged,
  chooseOrganizeRule,
  copyVerifiedForMove,
  organizeLocalPath,
  type OrganizePathKind,
} from './organizeCore';
import { getDriveLetter, normalizePathKey } from './filesystem';
import { moveFileNoReplace, readFileAttributes } from './windowsService';
import { evaluateRecycleDecision, type RecycleBinPolicy } from './recycleBinService';
import type { LongTrashPort } from './deleteService';

const SOURCE_BATCH_SIZE = 2000;
const MAX_PREVIEW_MATCHES = 10000;
const TOO_MANY_MATCHES = '命中规则的文件超过 10000 个，请缩小来源或规则范围';

interface PlannedItem {
  item: OrganizeItem;
  before: fs.Stats;
  parent: fs.Stats;
  createDir: string | null;
}
interface OrganizeDeps {
  db: DatabaseSync;
  fixedDrives(): Set<string>;
  protectedPaths: string[];
  getRecyclePolicy(drive: string): RecycleBinPolicy;
  trashItem(file: string): Promise<void>;
  longTrash: LongTrashPort;
}

export class OrganizeService {
  private preview: { token: string; scanId: number; entries: PlannedItem[] } | null = null;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private planning = false;
  private state: OrganizeState = {
    status: 'idle',
    total: 0,
    processed: 0,
    currentPath: '',
    results: [],
  };
  constructor(private readonly deps: OrganizeDeps) {}
  getState(): OrganizeState {
    return structuredClone(this.state);
  }
  isRunning(): boolean {
    return this.active !== null;
  }
  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }
  cancel(): OrganizeState {
    if (this.controller) {
      this.state.status = 'cancelling';
      this.controller.abort();
    }
    return this.getState();
  }
  private local(value: string, kind: OrganizePathKind = 'file'): string {
    return organizeLocalPath(value, this.deps.fixedDrives(), this.deps.protectedPaths, kind);
  }
  private async scanSource(
    scanId: number,
    sourceDir: string,
    visit: (files: FileRecord[]) => void,
  ): Promise<void> {
    const base = normalizePathKey(sourceDir).replace(/\\+$/, '');
    const prefix = `${base}\\`;
    let afterId = 0;
    for (;;) {
      const ids = listSourceFileIds(this.deps.db, scanId, prefix, afterId, SOURCE_BATCH_SIZE);
      if (ids.length === 0) return;
      afterId = ids[ids.length - 1];
      visit(getFilesByIds(this.deps.db, scanId, ids));
      if (ids.length < SOURCE_BATCH_SIZE) return;
      await setImmediate();
    }
  }
  async plan(input: OrganizePreviewRequest): Promise<OrganizePreview> {
    if (this.isRunning()) throw new Error('整理任务进行中');
    if (this.planning) throw new Error('正在生成预览，请稍候');
    this.planning = true;
    try {
      this.preview = null;
      const scanId = getActiveScanId(this.deps.db);
      if (scanId === null) throw new Error('请先扫描文件');
      const sourceDir = this.local(input.sourceDir, 'directory');
      if (!fs.statSync(sourceDir).isDirectory()) throw new Error('来源必须是文件夹');
      const rules = input.rules
        .filter((rule) => rule.enabled)
        .map((rule) => {
          const targetDir = this.local(rule.targetDir, 'directory');
          if (!fs.statSync(targetDir).isDirectory()) throw new Error('目标必须是文件夹');
          return { ...rule, targetDir };
        });
      if (rules.length === 0) throw new Error('请添加并启用至少一条规则');
      const entries: PlannedItem[] = [];
      const items: OrganizeItem[] = [];
      const reserved = new Set<string>();
      await this.scanSource(scanId, sourceDir, (files) => {
        for (const file of files) {
          const rule = chooseOrganizeRule(file, rules, input.priority);
          if (!rule) continue;
          let target = path.join(rule.targetDir, file.name);
          const item: OrganizeItem = {
            id: file.id,
            source: file.path,
            target,
            size: file.size,
            rule: rule.name,
            crossDrive: false,
            allowed: false,
            message: '',
          };
          items.push(item);
          try {
            this.local(file.path);
            const before = fs.lstatSync(file.path);
            if (
              !before.isFile() ||
              before.size !== file.size ||
              Math.trunc(before.mtimeMs) !== Math.trunc(file.mtimeMs)
            )
              throw new Error('文件已变化，请重新扫描');
            if (normalizePathKey(target) === normalizePathKey(file.path))
              throw new Error('已在目标文件夹，无需移动');
            const { name, ext } = path.parse(file.name);
            let suffix = 0;
            while (fs.existsSync(target) || reserved.has(normalizePathKey(target))) {
              suffix += 1;
              if (suffix > 10000) throw new Error('目标同名文件过多');
              target = path.join(rule.targetDir, `${name} (${suffix})${ext}`);
            }
            reserved.add(normalizePathKey(target));
            item.target = target;
            const parent = fs.statSync(rule.targetDir);
            item.crossDrive =
              getDriveLetter(file.path) !== getDriveLetter(target) || before.dev !== parent.dev;
            if (item.crossDrive) this.checkRecycle(file.path, file.size);
            item.allowed = true;
            item.message = item.crossDrive
              ? '跨盘：复制校验后回收原件，须确认'
              : '同盘：直接移动，不重写文件内容';
            entries.push({ item, before, parent, createDir: null });
          } catch (error) {
            item.message = error instanceof Error ? error.message : String(error);
          }
          if (items.length > MAX_PREVIEW_MATCHES) throw new Error(TOO_MANY_MATCHES);
        }
      });
      const token = randomUUID();
      this.preview = { token, scanId, entries };
      return { token, items };
    } finally {
      this.planning = false;
    }
  }
  private checkRecycle(source: string, size: number, usedBytes = 0): void {
    if (this.deps.longTrash.needsQuarantine(source)) return;
    const decision = evaluateRecycleDecision(
      this.deps.getRecyclePolicy(`${getDriveLetter(source)}\\`),
      size,
      usedBytes,
    );
    if (!decision.allowed) throw new Error(decision.message ?? '无法保证原件可恢复');
  }
  async planSmart(input: SmartOrganizePreviewRequest): Promise<OrganizePreview> {
    if (this.isRunning()) throw new Error('整理任务进行中');
    if (this.planning) throw new Error('正在生成预览，请稍候');
    this.planning = true;
    try {
      this.preview = null;
      const scanId = getActiveScanId(this.deps.db);
      if (scanId === null) throw new Error('请先扫描文件');
      const sourceDir = this.local(input.sourceDir, 'directory');
      if (!fs.statSync(sourceDir).isDirectory()) throw new Error('来源必须是文件夹');
      const targetRoot = this.local(input.targetRoot, 'directory');
      const rootStat = fs.statSync(targetRoot);
      if (!rootStat.isDirectory()) throw new Error('目标根目录必须是文件夹');
      const categories = new Set(input.categories);

      const dirState = new Map<
        SmartCategory,
        { dir: string; blocked: string | null; dev: number }
      >();
      for (const category of categories) {
        const dir = path.join(targetRoot, SMART_CATEGORY_LABELS[category]);
        let blocked: string | null = null;
        let dev = rootStat.dev;
        if (fs.existsSync(dir)) {
          const st = fs.lstatSync(dir);
          const attr = readFileAttributes(dir);
          if (st.isSymbolicLink()) blocked = '目标文件夹不能是链接';
          else if (attr?.reparsePoint) blocked = '目标文件夹不能是重解析点';
          else if (!st.isDirectory()) blocked = '目标位置被同名文件占用';
          else dev = st.dev;
        }
        dirState.set(category, { dir, blocked, dev });
      }

      const entries: PlannedItem[] = [];
      const items: OrganizeItem[] = [];
      const reserved = new Set<string>();
      await this.scanSource(scanId, sourceDir, (files) => {
        for (const file of files) {
          const category = smartCategoryOf(file.type);
          if (!categories.has(category)) continue;
          const state = dirState.get(category)!;
          let target = path.join(state.dir, file.name);
          const item: OrganizeItem = {
            id: file.id,
            source: file.path,
            target,
            size: file.size,
            rule: SMART_CATEGORY_LABELS[category],
            crossDrive: false,
            allowed: false,
            message: '',
          };
          items.push(item);
          try {
            if (state.blocked) throw new Error(state.blocked);
            this.local(file.path);
            const before = fs.lstatSync(file.path);
            if (
              !before.isFile() ||
              before.size !== file.size ||
              Math.trunc(before.mtimeMs) !== Math.trunc(file.mtimeMs)
            )
              throw new Error('文件已变化，请重新扫描');
            if (normalizePathKey(target) === normalizePathKey(file.path))
              throw new Error('已在目标文件夹，无需移动');
            const { name, ext } = path.parse(file.name);
            let suffix = 0;
            while (fs.existsSync(target) || reserved.has(normalizePathKey(target))) {
              suffix += 1;
              if (suffix > 10000) throw new Error('目标同名文件过多');
              target = path.join(state.dir, `${name} (${suffix})${ext}`);
            }
            reserved.add(normalizePathKey(target));
            item.target = target;
            item.crossDrive =
              getDriveLetter(file.path) !== getDriveLetter(target) || before.dev !== state.dev;
            if (item.crossDrive) this.checkRecycle(file.path, file.size);
            item.allowed = true;
            item.message = item.crossDrive
              ? '跨盘：复制校验后回收原件，须确认'
              : '同盘：直接移动，不重写文件内容';
            entries.push({ item, before, parent: rootStat, createDir: state.dir });
          } catch (error) {
            item.message = error instanceof Error ? error.message : String(error);
          }
          if (items.length > MAX_PREVIEW_MATCHES) throw new Error(TOO_MANY_MATCHES);
        }
      });
      const token = randomUUID();
      this.preview = { token, scanId, entries };
      return { token, items };
    } finally {
      this.planning = false;
    }
  }
  start(input: OrganizeStartRequest): OrganizeState {
    if (this.isRunning()) throw new Error('整理任务进行中');
    const plan = this.preview;
    if (!plan || input.token !== plan.token || plan.scanId !== getActiveScanId(this.deps.db))
      throw new Error('预览已失效，请重新预览');
    const ids = new Set(input.fileIds);
    const entries = plan.entries.filter(({ item }) => ids.has(item.id));
    if (!ids.size || entries.length !== ids.size) throw new Error('包含不可移动文件，请重新选择');
    if (entries.some(({ item }) => item.crossDrive) && !input.confirmCrossDrive)
      throw new Error('跨盘移动必须明确确认');
    const used = new Map<string, number>();
    for (const { item } of entries) {
      if (!item.crossDrive) continue;
      const drive = getDriveLetter(item.source);
      this.checkRecycle(item.source, item.size, used.get(drive) ?? 0);
      used.set(drive, (used.get(drive) ?? 0) + item.size);
    }
    this.preview = null;
    this.controller = new AbortController();
    this.state = {
      status: 'running',
      total: entries.length,
      processed: 0,
      currentPath: '',
      results: [],
    };
    this.active = this.run(plan.scanId, entries, this.controller.signal).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.getState();
  }
  private async run(scanId: number, entries: PlannedItem[], signal: AbortSignal): Promise<void> {
    for (const { item, before, parent, createDir } of entries) {
      await setImmediate();
      if (signal.aborted) break;
      let published = false;
      let moved = false;
      this.state.currentPath = item.source;
      try {
        this.local(item.source);
        let directory: string;
        if (createDir) {
          const anchor = this.local(path.dirname(createDir), 'directory');
          const currentParent = fs.statSync(anchor);
          if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev)
            throw new Error('目标目录已变化，请重新预览');
          this.ensureCategoryDir(createDir);
          directory = this.local(createDir, 'directory');
        } else {
          directory = this.local(path.dirname(item.target), 'directory');
          const currentParent = fs.statSync(directory);
          if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev)
            throw new Error('目标目录已变化，请重新预览');
        }
        assertUnchanged(item.source, before);
        if (getFileById(this.deps.db, scanId, item.id)?.path !== item.source)
          throw new Error('文件索引已变化，请重新预览');
        if (item.crossDrive) {
          this.checkRecycle(item.source, item.size);
          const space = await fs.promises.statfs(directory);
          if (space.bavail * space.bsize < item.size + 64 * 1024 * 1024)
            throw new Error('目标硬盘空间不足');
          await copyVerifiedForMove(item.source, item.target, signal);
          published = true;
          signal.throwIfAborted();
          this.local(item.source);
          assertUnchanged(item.source, before);
          this.checkRecycle(item.source, item.size);
          if (this.deps.longTrash.needsQuarantine(item.source)) {
            await this.deps.longTrash.quarantine(item.source);
          } else {
            await this.deps.trashItem(item.source);
          }
        } else {
          signal.throwIfAborted();
          moveFileNoReplace(item.source, item.target);
          published = true;
        }
        moved = true;
        updateOrganizedFile(this.deps.db, scanId, item.id, item.source, item.target);
        this.state.results.push({
          source: item.source,
          target: item.target,
          status: 'moved',
          message: item.crossDrive
            ? '移动完成，原件在回收站或长路径回收区可还原'
            : '同盘移动完成，文件内容未改写',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state.results.push({
          source: item.source,
          target: published ? item.target : '',
          status: signal.aborted ? 'cancelled' : 'failed',
          message: moved
            ? `文件已移动，索引更新失败，请重新扫描：${reason}`
            : published
              ? `原件及已生成副本保留：${reason}`
              : `原件保留：${reason}`,
        });
      }
      this.state.processed += 1;
    }
    this.state.currentPath = '';
    this.state.status = signal.aborted ? 'cancelled' : 'completed';
  }
  private ensureCategoryDir(dir: string): void {
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) throw new Error('目标文件夹不能是链接');
      const attr = readFileAttributes(dir);
      if (attr?.reparsePoint) throw new Error('目标文件夹不能是重解析点');
      if (!st.isDirectory()) throw new Error('目标位置被同名文件占用');
      return;
    }
    fs.mkdirSync(dir);
  }
}
