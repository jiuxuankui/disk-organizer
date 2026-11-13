import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DatabaseCorruptError,
  DatabaseOpenError,
  databaseExists,
  openDatabase,
} from '../../src/main/db/connection';
import { SchemaTooNewError, LATEST_SCHEMA_VERSION } from '../../src/main/db/migrate';
import { createScan, getScanSummary, setActiveScanId } from '../../src/main/db/scansRepo';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDb(): { dir: string; dbPath: string; cleanup(): void } {
  const temp = createTempDbPath();
  cleanups.push(temp.cleanup);
  return temp;
}

describe('database connection and migrations', () => {
  it('creates the schema and records the schema version', () => {
    const { dbPath } = tempDb();
    const db = openDatabase(dbPath);
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(meta.value).toBe(String(LATEST_SCHEMA_VERSION));
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'meta',
          'scans',
          'drives',
          'scan_staging',
          'files',
          'hash_cache',
          'duplicate_runs',
          'duplicate_groups',
          'duplicate_members',
        ]),
      );
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journal.journal_mode.toLowerCase()).toBe('wal');
      const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(foreignKeys.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
    expect(databaseExists(dbPath)).toBe(true);
  });

  it('keeps data across close and reopen without recreating tables', () => {
    const { dbPath } = tempDb();
    const first = openDatabase(dbPath);
    const scanId = createScan(first, ['C:'], 1000);
    setActiveScanId(first, scanId);
    first
      .prepare(
        "UPDATE scans SET status = 'completed', finished_at = 2000, total_files = 2, identified_bytes = 30 WHERE id = ?",
      )
      .run(scanId);
    first.close();

    const second = openDatabase(dbPath);
    try {
      const version = second.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
      const summary = getScanSummary(second, scanId);
      expect(summary?.status).toBe('completed');
      expect(summary?.totalFiles).toBe(2);
      expect(summary?.identifiedBytes).toBe(30);
      const scanCount = second.prepare('SELECT COUNT(*) AS c FROM scans').get() as { c: number };
      expect(scanCount.c).toBe(1);
    } finally {
      second.close();
    }
  });

  it('rejects corrupted database files', () => {
    const { dbPath } = tempDb();
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x7a));
    expect(() => openDatabase(dbPath)).toThrow(DatabaseCorruptError);
  });

  it('rejects databases created by a newer schema', () => {
    const { dbPath } = tempDb();
    const db = openDatabase(dbPath);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(dbPath)).toThrow(SchemaTooNewError);
  });

  it('enforces foreign keys', () => {
    const { dbPath } = tempDb();
    const db = openDatabase(dbPath);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO files
              (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
             VALUES (9999, 'C:', 'C:\\x.txt', 'c:\\x.txt', 'x.txt', 'x.txt', 'txt', 'document', 1, 0, 0, '', 'C:\\', 'c:\\', '', '')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('reports a typed open error when the data directory cannot be created', () => {
    const { dir } = tempDb();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    let caught: unknown;
    try {
      openDatabase(path.join(blocker, 'nested', 'index.db'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseOpenError);
    expect((caught as Error).message).toContain('无法创建数据目录');

    const { dbPath } = tempDb();
    const db = openDatabase(dbPath);
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
