import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/main/db/connection';
import { createScan } from '../../src/main/db/scansRepo';
import { cleanupScanSnapshots } from '../../src/main/services/cleanupService';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function createDb(): DatabaseSync {
  const temp = createTempDbPath('disk-organizer-cleanup-');
  const db = openDatabase(temp.dbPath);
  cleanups.push(() => {
    db.close();
    temp.cleanup();
  });
  return db;
}

function insertFile(db: DatabaseSync, scanId: number, filePath: string, size: number): void {
  db.prepare(
    `INSERT INTO files
      (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
     VALUES (?, 'C:', ?, ?, ?, ?, 'bin', 'program', ?, 1, 1, '', ?, ?, '', '')`,
  ).run(
    scanId,
    filePath,
    filePath.toLowerCase(),
    path.win32.basename(filePath),
    path.win32.basename(filePath).toLowerCase(),
    size,
    path.win32.dirname(filePath),
    path.win32.dirname(filePath).toLowerCase(),
  );
}

function insertStaging(db: DatabaseSync, scanId: number, filePath: string): void {
  db.prepare(
    'INSERT INTO scan_staging (scan_id, drive, path, path_key) VALUES (?, ?, ?, ?)',
  ).run(scanId, 'C:', filePath, filePath.toLowerCase());
}

function insertHash(
  db: DatabaseSync,
  filePath: string,
  size: number,
  mtimeMs: number,
): void {
  db.prepare(
    'INSERT INTO hash_cache (path_key, size, mtime_ms, updated_at) VALUES (?, ?, ?, 1)',
  ).run(filePath.toLowerCase(), size, mtimeMs);
}

function count(db: DatabaseSync, table: 'files' | 'scan_staging' | 'hash_cache', scanId?: number): number {
  const row =
    scanId === undefined
      ? (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number })
      : (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE scan_id = ?`).get(scanId) as {
          c: number;
        });
  return row.c;
}

describe('cleanupScanSnapshots', () => {
  it('purges stale snapshots and leftover staging while keeping the active snapshot', async () => {
    const db = createDb();
    const active = createScan(db, ['C:'], 1);
    const stale = createScan(db, ['D:'], 2);
    insertFile(db, active, 'C:\\keep.bin', 10);
    insertFile(db, stale, 'D:\\gone-1.bin', 20);
    insertFile(db, stale, 'D:\\gone-2.bin', 30);
    insertStaging(db, active, 'C:\\leftover.bin');
    insertStaging(db, stale, 'D:\\leftover.bin');
    insertHash(db, 'C:\\keep.bin', 10, 1);
    insertHash(db, 'D:\\gone-1.bin', 20, 1);

    let yields = 0;
    const result = await cleanupScanSnapshots(db, active, {
      batchSize: 1,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    expect(result.files).toBe(2);
    expect(result.staging).toBe(2);
    expect(result.hashCache).toBe(1);
    expect(yields).toBeGreaterThan(0);
    expect(count(db, 'files', active)).toBe(1);
    expect(count(db, 'files', stale)).toBe(0);
    expect(count(db, 'scan_staging', active)).toBe(0);
    expect(count(db, 'scan_staging', stale)).toBe(0);
    const hashes = db.prepare('SELECT path_key FROM hash_cache').all() as Array<{
      path_key: string;
    }>;
    expect(hashes.map((row) => row.path_key)).toEqual(['c:\\keep.bin']);
  });

  it('clears everything when no scan is active', async () => {
    const db = createDb();
    const first = createScan(db, ['C:'], 1);
    const second = createScan(db, ['D:'], 2);
    insertFile(db, first, 'C:\\a.bin', 1);
    insertFile(db, second, 'D:\\b.bin', 2);
    insertStaging(db, first, 'C:\\c.bin');
    insertHash(db, 'C:\\a.bin', 1, 1);
    insertHash(db, 'D:\\b.bin', 2, 1);

    const result = await cleanupScanSnapshots(db, null, { batchSize: 1 });

    expect(result.files).toBe(2);
    expect(result.staging).toBe(1);
    expect(result.hashCache).toBe(2);
    expect(count(db, 'files')).toBe(0);
    expect(count(db, 'scan_staging')).toBe(0);
    expect(count(db, 'hash_cache')).toBe(0);
  });
});
