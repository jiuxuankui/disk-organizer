import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db/connection';
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrate';
import { BackupService, quarantineDatabase } from '../../src/main/services/backupService';
import { createScan, finalizeScan, setActiveScanId } from '../../src/main/db/scansRepo';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Fixture {
  root: string;
  dbPath: string;
  backupDir: string;
  settingsPath: string;
  db: DatabaseSync;
  scanId: number;
}

function fixture(): Fixture {
  const temp = createTempDbPath('disk-organizer-backup-');
  cleanups.push(temp.cleanup);
  const root = temp.dir;
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, 'index.db');
  const settingsPath = path.join(dataDir, 'settings.json');
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ autoBackup: true }, null, 2));
  const db = openDatabase(dbPath);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // May be closed by a test.
    }
  });
  const scanId = createScan(db, ['C:'], 1000);
  finalizeScan(db, scanId, {
    totalFiles: 2,
    identifiedBytes: 1234,
    skipped: [],
    finishedAt: 2000,
  });
  return { root, dbPath, backupDir, settingsPath, db, scanId };
}

function serviceFor(fixtureValue: Fixture, now = 10_000): BackupService {
  return new BackupService({
    db: fixtureValue.db,
    dbPath: fixtureValue.dbPath,
    backupDir: fixtureValue.backupDir,
    settingsPath: fixtureValue.settingsPath,
    now: () => now,
    keep: 3,
  });
}

describe('backup service', () => {
  it('creates a consistent database copy with its settings and lists it', async () => {
    const f = fixture();
    try {
      const service = serviceFor(f);
      const entry = await service.create();
      expect(fs.existsSync(entry.path)).toBe(true);
      expect(entry.fileName).toMatch(/^index-\d{8}-\d{6}-\d{3}\.db$/);
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.settingsPath).not.toBeNull();
      expect(fs.existsSync(entry.settingsPath!)).toBe(true);

      const copies = service.list();
      expect(copies).toHaveLength(1);
      expect(copies[0].path).toBe(entry.path);
      expect(copies[0].settingsPath).toBe(entry.settingsPath);

      const check = new DatabaseSync(entry.path, { readOnly: true });
      try {
        const rows = check.prepare('SELECT COUNT(*) AS count FROM scans').get() as {
          count: number;
        };
        expect(rows.count).toBe(1);
      } finally {
        check.close();
      }

      expect(service.validate(entry.path)).toEqual({ ok: true });
    } finally {
      f.db.close();
    }
  });

  it('rotates to the three newest backups', async () => {
    const f = fixture();
    try {
      const service = serviceFor(f);
      const entries = [];
      for (const now of [10_000, 20_000, 30_000, 40_000]) {
        entries.push(await serviceFor(f, now).create());
      }
      const listed = service.list();
      expect(listed).toHaveLength(3);
      const names = listed.map((item) => item.fileName);
      expect(names).not.toContain(entries[0].fileName);
      expect(names).toContain(entries[3].fileName);
      expect(fs.existsSync(entries[0].path)).toBe(false);
      expect(fs.existsSync(entries[0].settingsPath!)).toBe(false);
    } finally {
      f.db.close();
    }
  });

  it('rejects corrupt, foreign or too-new backups', async () => {
    const f = fixture();
    try {
      const service = serviceFor(f);
      const entry = await service.create();

      const garbage = path.join(f.backupDir, 'index-29990101-000000-000.db');
      fs.writeFileSync(garbage, 'not a sqlite file');
      expect(service.validate(garbage).ok).toBe(false);

      const outside = path.join(f.root, entry.fileName);
      fs.copyFileSync(entry.path, outside);
      expect(service.validate(outside)).toEqual({
        ok: false,
        error: '只能从软件自动备份目录恢复',
      });

      const invalidName = path.join(f.backupDir, 'random.db');
      fs.copyFileSync(entry.path, invalidName);
      expect(service.validate(invalidName)).toEqual({
        ok: false,
        error: '备份文件名无效',
      });

      const tooNew = path.join(f.backupDir, 'index-29990101-000000-001.db');
      const raw = new DatabaseSync(tooNew);
      raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
      raw.close();
      expect(service.validate(tooNew)).toEqual({
        ok: false,
        error: '该备份来自更新版本的软件，无法恢复',
      });

      expect(service.validate(path.join(f.backupDir, 'index-29990101-000000-002.db'))).toEqual({
        ok: false,
        error: '备份文件不存在',
      });
    } finally {
      f.db.close();
    }
  });

  it('skips damaged backups when picking the latest valid one', async () => {
    const f = fixture();
    try {
      const older = await serviceFor(f, 10_000).create();
      const newer = await serviceFor(f, 20_000).create();
      fs.writeFileSync(newer.path, 'broken');
      const service = serviceFor(f);
      expect(service.latestValid()?.path).toBe(older.path);
    } finally {
      f.db.close();
    }
  });

  it('prefers the newest backup that still has a restorable scan', async () => {
    const f = fixture();
    try {
      setActiveScanId(f.db, f.scanId);
      const withData = await serviceFor(f, 10_000).create();
      f.db.exec("DELETE FROM scans; DELETE FROM meta WHERE key = 'active_scan_id'");
      const empty = await serviceFor(f, 20_000).create();
      const service = serviceFor(f);
      expect(service.list()[0].path).toBe(empty.path);
      expect(service.latestValid()?.path).toBe(withData.path);
    } finally {
      f.db.close();
    }
  });

  it('restores the database and settings from a backup', async () => {
    const f = fixture();
    try {
      const service = serviceFor(f);
      const entry = await service.create();

      f.db.exec('DELETE FROM scans');
      fs.writeFileSync(f.settingsPath, '{"changed":true}');
      expect(
        (f.db.prepare('SELECT COUNT(*) AS count FROM scans').get() as { count: number }).count,
      ).toBe(0);

      f.db.close();
      service.copyIntoPlace(entry);

      const restored = openDatabase(f.dbPath);
      try {
        const count = (
          restored.prepare('SELECT COUNT(*) AS count FROM scans').get() as { count: number }
        ).count;
        expect(count).toBe(1);
      } finally {
        restored.close();
      }
      expect(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'))).toEqual({ autoBackup: true });
    } finally {
      try {
        f.db.close();
      } catch {
        // Already closed.
      }
    }
  });

  it('quarantines a damaged database and clears WAL files', () => {
    const f = fixture();
    try {
      f.db.close();
      fs.writeFileSync(`${f.dbPath}-wal`, 'wal');
      fs.writeFileSync(`${f.dbPath}-shm`, 'shm');
      const target = quarantineDatabase(f.dbPath, Date.UTC(2026, 10, 13, 8, 30, 0, 12));
      expect(path.basename(target)).toMatch(/^index\.db\.corrupt-\d{8}-\d{6}-\d{3}$/);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(f.dbPath)).toBe(false);
      expect(fs.existsSync(`${f.dbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${f.dbPath}-shm`)).toBe(false);
    } finally {
      try {
        f.db.close();
      } catch {
        // Already closed.
      }
    }
  });
});
