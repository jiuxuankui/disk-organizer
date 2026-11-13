import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { AppPaths } from '../../src/main/paths';
import { openDatabase } from '../../src/main/db/connection';
import { BackupService } from '../../src/main/services/backupService';
import { DataService } from '../../src/main/services/dataService';
import { createScan, finalizeScan, setActiveScanId } from '../../src/main/db/scansRepo';
import { normalizePathKey } from '../../src/main/services/filesystem';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Fixture {
  db: DatabaseSync;
  paths: AppPaths;
  dataDir: string;
  fileId: number;
  scanId: number;
}

function fixture(): Fixture {
  const temp = createTempDbPath('disk-organizer-data-');
  cleanups.push(temp.cleanup);
  const root = temp.dir;
  const dataDir = path.join(root, 'data');
  const paths: AppPaths = {
    rootDir: root,
    dataDir,
    backupDir: path.join(dataDir, 'backup'),
    logsDir: path.join(root, 'logs'),
    dbPath: path.join(dataDir, 'index.db'),
    settingsPath: path.join(dataDir, 'settings.json'),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(paths.settingsPath, JSON.stringify({ minDuplicateSize: 2048 }));
  const db = openDatabase(paths.dbPath);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // May be closed by a test.
    }
  });

  const scanId = createScan(db, ['C:'], 1000);
  const filePath = path.join(root, 'docs', 'a.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'hello');
  const inserted = db
    .prepare(
      `INSERT INTO files
        (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, 'C:', ?, ?, 'a.txt', 'a.txt', 'txt', 'document', 5, 1, 1, 'docs', ?, ?, 'v', 'f')`,
    )
    .run(
      scanId,
      filePath,
      normalizePathKey(filePath),
      path.win32.dirname(filePath),
      normalizePathKey(path.win32.dirname(filePath)),
    );
  const fileId = Number(inserted.lastInsertRowid);
  finalizeScan(db, scanId, {
    totalFiles: 1,
    identifiedBytes: 5,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);
  db.prepare(
    'INSERT INTO hash_cache (path_key, size, mtime_ms, quick_hash, full_hash, updated_at) VALUES (?, 5, 1, ?, ?, 1)',
  ).run(normalizePathKey(filePath), 'quick', 'full');
  db.prepare(
    'INSERT INTO scan_staging (scan_id, drive, path, path_key) VALUES (?, ?, ?, ?)',
  ).run(scanId, 'C:', filePath, normalizePathKey(filePath));
  const runId = Number(
    db
      .prepare(
        `INSERT INTO duplicate_runs (scan_id, status, min_size, created_at, finished_at, total_groups, total_files, reclaimable_bytes)
         VALUES (?, 'completed', 0, 1, 2, 1, 2, 5)`,
      )
      .run(scanId).lastInsertRowid,
  );
  const groupId = Number(
    db
      .prepare(
        `INSERT INTO duplicate_groups (run_id, size, file_count, reclaimable_bytes, type, mixed_ext)
         VALUES (?, 5, 2, 5, 'document', 0)`,
      )
      .run(runId).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO duplicate_members (group_id, file_id, path, name, mtime_ms, is_suggested_keep)
     VALUES (?, ?, ?, 'a.txt', 1, 1)`,
  ).run(groupId, fileId, filePath);

  return { db, paths, dataDir, fileId, scanId };
}

function count(db: DatabaseSync, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
}

describe('data service', () => {
  it('reports the data directory, database size and backups', async () => {
    const f = fixture();
    try {
      const backup = new BackupService({
        db: f.db,
        dbPath: f.paths.dbPath,
        backupDir: f.paths.backupDir,
        settingsPath: f.paths.settingsPath,
      });
      await backup.create();
      const service = new DataService({ db: f.db, paths: f.paths, backup });
      const info = service.info();
      expect(info.dataDir).toBe(f.dataDir);
      expect(info.dbPath).toBe(f.paths.dbPath);
      expect(info.dbSizeBytes).toBeGreaterThan(0);
      expect(info.backups).toHaveLength(1);
      expect(fs.existsSync(info.backups[0].path)).toBe(true);
    } finally {
      f.db.close();
    }
  });

  it('backs up before clearing and removes index data while keeping settings', async () => {
    const f = fixture();
    try {
      const backup = new BackupService({
        db: f.db,
        dbPath: f.paths.dbPath,
        backupDir: f.paths.backupDir,
        settingsPath: f.paths.settingsPath,
      });
      const service = new DataService({ db: f.db, paths: f.paths, backup });
      const result = await service.clear();
      expect(result.backup).not.toBeNull();
      expect(fs.existsSync(result.backup!.path)).toBe(true);

      for (const table of [
        'files',
        'scans',
        'scan_staging',
        'hash_cache',
        'duplicate_runs',
        'duplicate_groups',
        'duplicate_members',
      ]) {
        expect(count(f.db, table)).toBe(0);
      }
      expect(
        f.db.prepare("SELECT value FROM meta WHERE key = 'active_scan_id'").get(),
      ).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(f.paths.settingsPath, 'utf8'))).toEqual({
        minDuplicateSize: 2048,
      });

      const restored = new BackupService({
        db: f.db,
        dbPath: f.paths.dbPath,
        backupDir: f.paths.backupDir,
        settingsPath: f.paths.settingsPath,
      }).latestValid();
      expect(restored).not.toBeNull();
      expect(restored!.path).toBe(result.backup!.path);
    } finally {
      f.db.close();
    }
  });

  it('keeps at most three automatic backups across repeated clears', async () => {
    const f = fixture();
    try {
      let tick = 10_000;
      const backup = new BackupService({
        db: f.db,
        dbPath: f.paths.dbPath,
        backupDir: f.paths.backupDir,
        settingsPath: f.paths.settingsPath,
        now: () => tick,
      });
      const service = new DataService({ db: f.db, paths: f.paths, backup });
      for (let index = 0; index < 4; index += 1) {
        tick += 1_000;
        await service.clear();
      }
      const listed = backup.list();
      expect(listed).toHaveLength(3);
    } finally {
      f.db.close();
    }
  });
});
