import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupFileInfo } from '@shared/types';
import { LATEST_SCHEMA_VERSION } from '../db/migrate';

const BACKUP_NAME = /^index-(\d{8}-\d{6}-\d{3})\.db$/;
const KEEP_COUNT = 3;

export interface BackupServiceDeps {
  db?: DatabaseSync;
  dbPath: string;
  backupDir: string;
  settingsPath: string;
  now?: () => number;
  keep?: number;
}

function stampOf(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    pad(date.getMilliseconds(), 3)
  );
}

export function quarantineDatabase(dbPath: string, now = Date.now()): string {
  const stamp = stampOf(new Date(now));
  const target = `${dbPath}.corrupt-${stamp}`;
  fs.renameSync(dbPath, target);
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // WAL cleanup is best effort.
    }
  }
  return target;
}

export class BackupService {
  private readonly db: DatabaseSync | undefined;
  private readonly dbPath: string;
  private readonly backupDir: string;
  private readonly settingsPath: string;
  private readonly now: () => number;
  private readonly keep: number;

  constructor(deps: BackupServiceDeps) {
    this.db = deps.db;
    this.dbPath = deps.dbPath;
    this.backupDir = deps.backupDir;
    this.settingsPath = deps.settingsPath;
    this.now = deps.now ?? Date.now;
    this.keep = Math.max(1, deps.keep ?? KEEP_COUNT);
  }

  list(): BackupFileInfo[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.backupDir);
    } catch {
      return [];
    }
    const result: BackupFileInfo[] = [];
    for (const name of names) {
      if (!BACKUP_NAME.test(name)) continue;
      const filePath = path.join(this.backupDir, name);
      try {
        const stats = fs.statSync(filePath);
        const settingsName = name.replace(/^index-/, 'settings-').replace(/\.db$/, '.json');
        const settingsPath = path.join(this.backupDir, settingsName);
        result.push({
          fileName: name,
          path: filePath,
          createdAt: Math.round(stats.mtimeMs),
          sizeBytes: stats.size,
          settingsPath: fs.existsSync(settingsPath) ? settingsPath : null,
        });
      } catch {
        // Skip unreadable backups.
      }
    }
    return result.sort((a, b) => b.fileName.localeCompare(a.fileName));
  }

  async create(): Promise<BackupFileInfo> {
    if (!this.db) throw new Error('数据库尚未打开，无法备份');
    fs.mkdirSync(this.backupDir, { recursive: true });
    let offset = 0;
    let fileName = `index-${stampOf(new Date(this.now()))}.db`;
    while (fs.existsSync(path.join(this.backupDir, fileName))) {
      offset += 1;
      fileName = `index-${stampOf(new Date(this.now() + offset))}.db`;
    }
    const backupPath = path.join(this.backupDir, fileName);
    await backup(this.db, backupPath);
    if (fs.existsSync(this.settingsPath)) {
      fs.copyFileSync(
        this.settingsPath,
        path.join(this.backupDir, fileName.replace(/^index-/, 'settings-').replace(/\.db$/, '.json')),
      );
    }
    this.prune();
    const stats = fs.statSync(backupPath);
    const settingsPath = path.join(
      this.backupDir,
      fileName.replace(/^index-/, 'settings-').replace(/\.db$/, '.json'),
    );
    return {
      fileName,
      path: backupPath,
      createdAt: Math.round(stats.mtimeMs),
      sizeBytes: stats.size,
      settingsPath: fs.existsSync(settingsPath) ? settingsPath : null,
    };
  }

  private prune(): void {
    const entries = this.list();
    for (const entry of entries.slice(this.keep)) {
      try {
        fs.rmSync(entry.path, { force: true });
        if (entry.settingsPath) fs.rmSync(entry.settingsPath, { force: true });
      } catch {
        // Rotation is best effort; keep the remaining backups usable.
      }
    }
  }

  validate(backupPath: string): { ok: true } | { ok: false; error: string } {
    const resolved = path.resolve(backupPath);
    if (path.dirname(resolved) !== path.resolve(this.backupDir)) {
      return { ok: false, error: '只能从软件自动备份目录恢复' };
    }
    if (!BACKUP_NAME.test(path.basename(resolved))) {
      return { ok: false, error: '备份文件名无效' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: '备份文件不存在' };
    let checkDb: DatabaseSync | null = null;
    try {
      checkDb = new DatabaseSync(resolved, { readOnly: true });
      const result = checkDb.prepare('PRAGMA quick_check').get() as
        | { quick_check: string }
        | undefined;
      if (!result || result.quick_check !== 'ok') {
        return { ok: false, error: '备份文件完整性检查未通过' };
      }
      const version = checkDb.prepare('PRAGMA user_version').get() as
        | { user_version: number }
        | undefined;
      if ((version?.user_version ?? 0) > LATEST_SCHEMA_VERSION) {
        return { ok: false, error: '该备份来自更新版本的软件，无法恢复' };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `无法读取备份文件：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      try {
        checkDb?.close();
      } catch {
        // Ignore close failures on validation handles.
      }
    }
  }

  latestValid(): BackupFileInfo | null {
    const valid = this.list().filter((entry) => this.validate(entry.path).ok);
    return valid.find((entry) => this.hasRestorableScan(entry.path)) ?? valid[0] ?? null;
  }

  private hasRestorableScan(backupPath: string): boolean {
    let checkDb: DatabaseSync | null = null;
    try {
      checkDb = new DatabaseSync(backupPath, { readOnly: true });
      const row = checkDb
        .prepare("SELECT value FROM meta WHERE key = 'active_scan_id'")
        .get() as { value: string } | undefined;
      return Boolean(row?.value);
    } catch {
      return false;
    } finally {
      try {
        checkDb?.close();
      } catch {
        // Ignore close failures on validation handles.
      }
    }
  }

  private markDuplicatesStale(): void {
    let restored: DatabaseSync | null = null;
    try {
      restored = new DatabaseSync(this.dbPath);
      restored.exec("UPDATE duplicate_runs SET status = 'stale' WHERE status <> 'stale'");
    } catch {
      // The index itself was restored; duplicate results can be recomputed.
    } finally {
      try {
        restored?.close();
      } catch {
        // Ignore close failures on the temporary handle.
      }
    }
  }

  private settingsPathFor(entry: BackupFileInfo): string | null {
    if (entry.settingsPath && fs.existsSync(entry.settingsPath)) return entry.settingsPath;
    return null;
  }

  copyIntoPlace(entry: BackupFileInfo): void {
    const check = this.validate(entry.path);
    if (!check.ok) throw new Error(check.error);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const temp = `${this.dbPath}.restore-tmp`;
    fs.copyFileSync(entry.path, temp);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
      } catch {
        // WAL cleanup is best effort.
      }
    }
    try {
      fs.rmSync(this.dbPath, { force: true });
    } catch {
      // The rename below surfaces a meaningful error if the file is still locked.
    }
    fs.renameSync(temp, this.dbPath);
    this.markDuplicatesStale();
    const settings = this.settingsPathFor(entry);
    if (settings) fs.copyFileSync(settings, this.settingsPath);
  }
}
