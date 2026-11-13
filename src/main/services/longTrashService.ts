import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LongTrashEntry, LongTrashStatus } from '@shared/types';
import { getDriveLetter, toExtendedPath } from './filesystem';

export const LONG_PATH_LIMIT = 260;
export const LONG_TRASH_DIR_NAME = '.disk-organizer-trash';

interface StoredManifest {
  version: 1;
  entries: LongTrashEntry[];
}

export interface LongTrashDeps {
  rootDir: string;
  trashRoot?: (drive: string) => string;
  now?: () => number;
}

function defaultTrashRoot(drive: string): string {
  return path.win32.join(`${drive}\\`, LONG_TRASH_DIR_NAME);
}

function isEntry(value: unknown): value is LongTrashEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.originalPath === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.drive === 'string' &&
    typeof entry.storedPath === 'string' &&
    typeof entry.deletedAt === 'number'
  );
}

function shortName(name: string): string {
  const ext = path.win32.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base.slice(0, 80)}${ext.slice(0, 16)}`;
}

function moveFile(source: string, target: string): void {
  const from = toExtendedPath(source);
  const to = toExtendedPath(target);
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  fs.copyFileSync(from, to);
  fs.unlinkSync(from);
}

export class LongTrashService {
  private readonly rootDir: string;
  private readonly trashRoot: (drive: string) => string;
  private readonly now: () => number;
  private sequence = 0;

  constructor(deps: LongTrashDeps) {
    this.rootDir = deps.rootDir;
    this.trashRoot = deps.trashRoot ?? defaultTrashRoot;
    this.now = deps.now ?? Date.now;
  }

  get manifestPath(): string {
    return path.join(this.rootDir, 'long-trash.json');
  }

  needsQuarantine(filePath: string): boolean {
    return filePath.length >= LONG_PATH_LIMIT;
  }

  list(): LongTrashStatus {
    const entries = this.load().sort((a, b) => b.deletedAt - a.deletedAt);
    return {
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0),
      manifestPath: this.manifestPath,
    };
  }

  async quarantine(
    filePath: string,
    meta?: { size?: number; name?: string },
  ): Promise<LongTrashEntry> {
    if (!this.needsQuarantine(filePath)) {
      throw new Error('路径未超过 Windows 回收站的长度限制');
    }
    const drive = getDriveLetter(filePath);
    if (!drive) throw new Error('无法识别文件所在硬盘');
    const stats = fs.statSync(toExtendedPath(filePath));
    if (!stats.isFile()) throw new Error('只能移入普通文件');
    const dir = this.trashRoot(drive);
    fs.mkdirSync(toExtendedPath(dir), { recursive: true });

    const name = meta?.name ?? path.win32.basename(filePath);
    this.sequence += 1;
    let storedPath = '';
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate = path.win32.join(
        dir,
        `${this.now()}-${this.sequence}-${attempt}-${shortName(name)}`,
      );
      if (!fs.existsSync(toExtendedPath(candidate))) {
        storedPath = candidate;
        break;
      }
    }
    if (!storedPath) throw new Error('长路径回收区文件名冲突，请稍后重试');

    moveFile(filePath, storedPath);

    const entry: LongTrashEntry = {
      id: randomUUID(),
      originalPath: filePath,
      name,
      size: Number(stats.size),
      drive,
      storedPath,
      deletedAt: this.now(),
    };
    const entries = this.load();
    entries.push(entry);
    try {
      this.save(entries);
    } catch (error) {
      try {
        moveFile(storedPath, filePath);
      } catch {
        // Keep the original error; the quarantine entry is not written yet.
      }
      throw error;
    }
    return entry;
  }

  async restore(id: string): Promise<{ ok: boolean; error: string | null }> {
    const entries = this.load();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return { ok: false, error: '回收区中没有这条记录' };
    if (!fs.existsSync(toExtendedPath(entry.storedPath))) {
      return { ok: false, error: '回收区中的文件已不存在' };
    }
    if (fs.existsSync(toExtendedPath(entry.originalPath))) {
      return { ok: false, error: '原位置已有同名文件，为避免覆盖未还原' };
    }
    fs.mkdirSync(toExtendedPath(path.win32.dirname(entry.originalPath)), { recursive: true });
    moveFile(entry.storedPath, entry.originalPath);
    const remaining = entries.filter((item) => item.id !== id);
    try {
      this.save(remaining);
    } catch (error) {
      try {
        moveFile(entry.originalPath, entry.storedPath);
      } catch {
        // Keep the original error; the entry is still recorded.
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { ok: true, error: null };
  }

  private load(): LongTrashEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as StoredManifest | LongTrashEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      return Array.isArray(entries) ? entries.filter(isEntry) : [];
    } catch {
      throw new Error('长路径回收区清单已损坏，请检查数据目录');
    }
  }

  private save(entries: LongTrashEntry[]): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const payload: StoredManifest = { version: 1, entries };
    const tmp = `${this.manifestPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.manifestPath);
  }
}
