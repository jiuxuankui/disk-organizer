import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FileRecord } from '@shared/types';
import type {
  MovePreview,
  MovePreviewRequest,
  MoveStartRequest,
  OrganizeItem,
  OrganizePreview,
  OrganizePreviewRequest,
  OrganizePriority,
  OrganizeRule,
  OrganizeStartRequest,
  OrganizeState,
  SmartCategory,
  SmartOrganizePreviewRequest,
} from '@shared/organize';
import { SMART_CATEGORY_LABELS, smartCategoryOf, ORGANIZE_MATCH_LIMIT } from '@shared/organize';
import { getActiveScanId } from '../db/scansRepo';
import {
  getFileById,
  getFilesByIds,
  listSourceFileIds,
  listSourceFolderDirs,
} from '../db/filesRepo';
import { updateOrganizedFile, updateOrganizedFolder } from '../db/organizeRepo';
import {
  assertFolderUnchanged,
  assertUnchanged,
  chooseFolderRule,
  chooseOrganizeRule,
  copyVerifiedForMove,
  organizeLocalPath,
  type OrganizePathKind,
} from './organizeCore';
import { getDriveLetter, isSameOrSubPath, normalizePathKey } from './filesystem';
import { moveFileNoReplace, readFileAttributes } from './windowsService';
import { evaluateRecycleDecision, type RecycleBinPolicy } from './recycleBinService';
import type { LongTrashPort } from './deleteService';
import { cleanupEmptyParents } from './emptyFolderCleanup';

const SOURCE_BATCH_SIZE = 2000;
const TOO_MANY_MATCHES = `命中规则的文件超过 ${ORGANIZE_MATCH_LIMIT} 个，请缩小来源或规则范围`;

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
    cleanup: null,
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
  private resolveSources(values: string[]): string[] {
    const unique = new Map<string, string>();
    for (const value of values) {
      const dir = this.local(value, 'directory');
      if (!fs.statSync(dir).isDirectory()) throw new Error('来源必须是文件夹');
      const key = normalizePathKey(dir).replace(/\\+$/, '');
      if (!unique.has(key)) unique.set(key, dir);
    }
    const ordered = [...unique.entries()].sort((a, b) => a[0].length - b[0].length);
    const kept: string[] = [];
    for (const [key, dir] of ordered) {
      if (kept.some((parent) => isSameOrSubPath(key, normalizePathKey(parent)))) continue;
      kept.push(dir);
    }
    return kept;
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
      const sources = this.resolveSources(input.sourceDirs);
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
      for (const source of sources) {
        await this.scanSource(scanId, source, (files) => {
          for (const file of files) {
            const rule = chooseOrganizeRule(file, rules, input.priority);
            if (!rule) continue;
            let target = path.join(rule.targetDir, file.name);
            const item: OrganizeItem = {
              id: file.id,
              kind: 'file',
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
            if (items.length > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
          }
        });
      }
      const folderRules = rules.filter((rule) => rule.type === 'folder');
      const keptFolders = new Set<string>();
      if (folderRules.length > 0) {
        const candidates = (
          await this.collectFolders(scanId, sources, folderRules, input.priority)
        ).sort((a, b) => a.key.length - b.key.length);
        let nextFolderId = 0;
        for (const candidate of candidates) {
          if ([...keptFolders].some((parent) => isSameOrSubPath(candidate.key, parent))) continue;
          const item: OrganizeItem = {
            id: (nextFolderId -= 1),
            kind: 'folder',
            source: candidate.path,
            target: '',
            size: 0,
            rule: candidate.rule.name,
            crossDrive: false,
            allowed: false,
            message: '',
          };
          items.push(item);
          try {
            const dir = this.local(candidate.path, 'folder');
            const key = normalizePathKey(dir);
            const before = fs.lstatSync(dir);
            if (!before.isDirectory() || before.isSymbolicLink())
              throw new Error('文件夹已变化，请重新预览');
            const targetDir = candidate.rule.targetDir;
            if (isSameOrSubPath(targetDir, dir))
              throw new Error('目标文件夹不能位于来源文件夹内部');
            const name = path.basename(dir);
            let target = path.join(targetDir, name);
            item.target = target;
            if (normalizePathKey(target) === key) throw new Error('已在目标文件夹，无需移动');
            let suffix = 0;
            while (fs.existsSync(target) || reserved.has(normalizePathKey(target))) {
              suffix += 1;
              if (suffix > 10000) throw new Error('目标同名文件夹过多');
              target = path.join(targetDir, `${name} (${suffix})`);
            }
            item.target = target;
            const parent = fs.statSync(targetDir);
            if (getDriveLetter(dir) !== getDriveLetter(target) || before.dev !== parent.dev) {
              item.crossDrive = true;
              throw new Error('文件夹不支持跨盘整理');
            }
            reserved.add(normalizePathKey(target));
            item.allowed = true;
            item.message = '同盘：整目录移动，内部文件内容不重写';
            entries.push({ item, before, parent, createDir: null });
            keptFolders.add(key);
          } catch (error) {
            item.message = error instanceof Error ? error.message : String(error);
          }
          if (items.length > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
        }
      }
      if (keptFolders.size > 0) {
        const keepSource = (source: string): boolean =>
          ![...keptFolders].some((folder) => isSameOrSubPath(source, folder));
        const visible = items.filter((item) => item.kind === 'folder' || keepSource(item.source));
        const planned = entries.filter(
          (entry) => entry.item.kind === 'folder' || keepSource(entry.item.source),
        );
        items.length = 0;
        items.push(...visible);
        entries.length = 0;
        entries.push(...planned);
      }
      const token = randomUUID();
      this.preview = { token, scanId, entries };
      return { token, items };
    } finally {
      this.planning = false;
    }
  }
  private async collectFolders(
    scanId: number,
    sources: string[],
    rules: OrganizeRule[],
    priority: OrganizePriority,
  ): Promise<Array<{ path: string; key: string; rule: OrganizeRule }>> {
    const found = new Map<string, { path: string; key: string; rule: OrganizeRule }>();
    for (const source of sources) {
      const base = normalizePathKey(source).replace(/\\+$/, '');
      const prefix = `${base}\\`;
      let afterKey = '';
      for (;;) {
        const dirs = listSourceFolderDirs(
          this.deps.db,
          scanId,
          prefix,
          afterKey,
          SOURCE_BATCH_SIZE,
        );
        if (dirs.length === 0) break;
        afterKey = dirs[dirs.length - 1].key;
        for (const dir of dirs) {
          if (found.has(dir.key)) continue;
          const rule = chooseFolderRule(dir.path, rules, priority);
          if (rule) found.set(dir.key, { ...dir, rule });
        }
        if (found.size > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
        if (dirs.length < SOURCE_BATCH_SIZE) break;
        await setImmediate();
      }
    }
    return [...found.values()];
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
      const sources = this.resolveSources(input.sourceDirs);
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
      for (const source of sources) {
        await this.scanSource(scanId, source, (files) => {
          for (const file of files) {
            const category = smartCategoryOf(file.type);
            if (!categories.has(category)) continue;
            const state = dirState.get(category)!;
            let target = path.join(state.dir, file.name);
            const item: OrganizeItem = {
              id: file.id,
              kind: 'file',
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
            if (items.length > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
          }
        });
      }
      const token = randomUUID();
      this.preview = { token, scanId, entries };
      return { token, items };
    } finally {
      this.planning = false;
    }
  }
  async planMove(input: MovePreviewRequest): Promise<MovePreview> {
    if (this.isRunning()) throw new Error('整理任务进行中');
    if (this.planning) throw new Error('正在生成预览，请稍候');
    this.planning = true;
    try {
      this.preview = null;
      const scanId = getActiveScanId(this.deps.db);
      if (scanId === null) throw new Error('请先扫描文件');
      const targetDir = this.local(input.targetDir, 'directory');
      const targetStat = fs.statSync(targetDir);
      if (!targetStat.isDirectory()) throw new Error('目标必须是文件夹');
      const entries: PlannedItem[] = [];
      const items: OrganizeItem[] = [];
      const reserved = new Set<string>();
      const movedFolders: string[] = [];
      let nextFolderId = 0;

      const ordered = [
        ...new Map(input.folderPaths.map((folder) => [normalizePathKey(folder), folder])).values(),
      ].sort((a, b) => normalizePathKey(a).length - normalizePathKey(b).length);
      const selectedFolders = ordered.filter(
        (folder, index) =>
          !ordered.slice(0, index).some((parent) => isSameOrSubPath(folder, parent)),
      );
      for (const folderPath of selectedFolders) {
        const item: OrganizeItem = {
          id: (nextFolderId -= 1),
          kind: 'folder',
          source: folderPath,
          target: '',
          size: 0,
          rule: '手动移动',
          crossDrive: false,
          allowed: false,
          message: '',
        };
        items.push(item);
        try {
          const dir = this.local(folderPath, 'folder');
          const key = normalizePathKey(dir);
          const before = fs.lstatSync(dir);
          if (!before.isDirectory() || before.isSymbolicLink())
            throw new Error('文件夹已变化，请重新预览');
          const name = path.basename(dir);
          let target = path.join(targetDir, name);
          item.target = target;
          if (normalizePathKey(target) === key) throw new Error('已在目标文件夹，无需移动');
          if (isSameOrSubPath(targetDir, dir)) throw new Error('目标文件夹不能位于来源文件夹内部');
          let suffix = 0;
          while (fs.existsSync(target) || reserved.has(normalizePathKey(target))) {
            suffix += 1;
            if (suffix > 10000) throw new Error('目标同名文件夹过多');
            target = path.join(targetDir, `${name} (${suffix})`);
          }
          item.target = target;
          if (getDriveLetter(dir) !== getDriveLetter(target) || before.dev !== targetStat.dev) {
            item.crossDrive = true;
            throw new Error('文件夹不支持跨盘移动');
          }
          reserved.add(normalizePathKey(target));
          item.allowed = true;
          item.message = '同盘：整目录移动，内部文件内容不重写';
          entries.push({ item, before, parent: targetStat, createDir: null });
          movedFolders.push(key);
        } catch (error) {
          item.message = error instanceof Error ? error.message : String(error);
        }
        if (items.length > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
      }
      for (const id of new Set(input.fileIds)) {
        const file = getFileById(this.deps.db, scanId, id);
        if (!file) {
          items.push({
            id,
            kind: 'file',
            source: `#${id}`,
            target: '',
            size: 0,
            rule: '手动移动',
            crossDrive: false,
            allowed: false,
            message: '文件不在当前索引中，请重新扫描',
          });
          continue;
        }
        if (movedFolders.some((folder) => isSameOrSubPath(file.path, folder))) continue;
        let target = path.join(targetDir, file.name);
        const item: OrganizeItem = {
          id,
          kind: 'file',
          source: file.path,
          target,
          size: file.size,
          rule: '手动移动',
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
            target = path.join(targetDir, `${name} (${suffix})${ext}`);
          }
          reserved.add(normalizePathKey(target));
          item.target = target;
          item.crossDrive =
            getDriveLetter(file.path) !== getDriveLetter(target) || before.dev !== targetStat.dev;
          if (item.crossDrive) this.checkRecycle(file.path, file.size);
          item.allowed = true;
          item.message = item.crossDrive
            ? '跨盘：复制校验后回收原件，须确认'
            : '同盘：直接移动，不重写文件内容';
          entries.push({ item, before, parent: targetStat, createDir: null });
        } catch (error) {
          item.message = error instanceof Error ? error.message : String(error);
        }
        if (items.length > ORGANIZE_MATCH_LIMIT) throw new Error(TOO_MANY_MATCHES);
      }
      if (items.length === 0) throw new Error('所选项目已包含在文件夹中，请重新选择');
      const token = randomUUID();
      this.preview = { token, scanId, entries };
      const movable = items.filter((item) => item.allowed);
      return {
        token,
        items,
        movableCount: movable.length,
        blockedCount: items.length - movable.length,
        crossDriveCount: movable.filter((item) => item.crossDrive).length,
        fileCount: items.filter((item) => item.kind === 'file').length,
        folderCount: items.filter((item) => item.kind === 'folder').length,
        totalBytes: movable.reduce((sum, item) => sum + (item.kind === 'file' ? item.size : 0), 0),
        targetDir,
      };
    } finally {
      this.planning = false;
    }
  }
  startMove(input: MoveStartRequest): OrganizeState {
    if (this.isRunning()) throw new Error('整理任务进行中');
    const plan = this.preview;
    if (!plan || input.token !== plan.token || plan.scanId !== getActiveScanId(this.deps.db))
      throw new Error('预览已失效，请重新预览');
    const entries = plan.entries;
    if (entries.length === 0) throw new Error('没有可移动的项目');
    if (entries.some(({ item }) => item.crossDrive) && !input.confirmCrossDrive)
      throw new Error('跨盘移动必须明确确认');
    const used = new Map<string, number>();
    for (const { item } of entries) {
      if (!item.crossDrive) continue;
      const drive = getDriveLetter(item.source);
      this.checkRecycle(item.source, item.size, used.get(drive) ?? 0);
      used.set(drive, (used.get(drive) ?? 0) + item.size);
    }
    return this.begin(plan.scanId, entries);
  }
  private begin(scanId: number, entries: PlannedItem[]): OrganizeState {
    this.preview = null;
    this.controller = new AbortController();
    this.state = {
      status: 'running',
      total: entries.length,
      processed: 0,
      currentPath: '',
      results: [],
      cleanup: null,
    };
    this.active = this.run(scanId, entries, this.controller.signal).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.getState();
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
    return this.begin(plan.scanId, entries);
  }
  private async run(scanId: number, entries: PlannedItem[], signal: AbortSignal): Promise<void> {
    const emptyParents = new Set<string>();
    for (const { item, before, parent, createDir } of entries) {
      await setImmediate();
      if (signal.aborted) break;
      let published = false;
      let moved = false;
      this.state.currentPath = item.source;
      if (item.kind === 'folder') {
        let movedFolder = false;
        try {
          const dir = this.local(item.source, 'folder');
          const targetDir = this.local(path.dirname(item.target), 'directory');
          const currentParent = fs.statSync(targetDir);
          if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev)
            throw new Error('目标目录已变化，请重新预览');
          assertFolderUnchanged(dir, before);
          if (
            getDriveLetter(dir) !== getDriveLetter(item.target) ||
            before.dev !== currentParent.dev
          )
            throw new Error('文件夹不支持跨盘整理');
          if (normalizePathKey(item.target) === normalizePathKey(dir))
            throw new Error('已在目标文件夹，无需移动');
          signal.throwIfAborted();
          moveFileNoReplace(dir, item.target);
          movedFolder = true;
          emptyParents.add(path.dirname(dir));
          const updated = updateOrganizedFolder(this.deps.db, scanId, dir, item.target);
          if (updated === 0) throw new Error('文件夹索引已变化，请重新扫描');
          this.state.results.push({
            source: item.source,
            target: item.target,
            status: 'moved',
            message: '文件夹移动完成，内部文件随目录移动，索引已更新',
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.state.results.push({
            source: item.source,
            target: movedFolder ? item.target : '',
            status: signal.aborted ? 'cancelled' : 'failed',
            message: movedFolder
              ? `文件夹已移动，索引更新失败，请重新扫描：${reason}`
              : `原文件夹保留：${reason}`,
          });
        }
        this.state.processed += 1;
        continue;
      }
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
        emptyParents.add(path.dirname(item.source));
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
    if (emptyParents.size > 0) {
      try {
        const report = await cleanupEmptyParents([...emptyParents], {
          trashItem: (folder) => this.deps.trashItem(folder),
          protectedPaths: this.deps.protectedPaths,
        });
        this.state.cleanup = { cleaned: report.cleaned.length, failed: report.failed };
      } catch (error) {
        this.state.cleanup = {
          cleaned: 0,
          failed: [
            {
              path: '',
              reason: `自动清理空文件夹失败：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
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
