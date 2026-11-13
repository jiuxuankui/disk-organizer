import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import { openDatabase } from '../../src/main/db/connection';
import {
  createScan,
  finalizeScan,
  setActiveScanId,
} from '../../src/main/db/scansRepo';
import { normalizePathKey } from '../../src/main/services/filesystem';
import { createTempDbPath } from './helpers';
import {
  LONG_PATH_LIMIT,
  LongTrashService,
  type LongTrashDeps,
} from '../../src/main/services/longTrashService';
import { DeleteService } from '../../src/main/services/deleteService';
import type { RecycleBinPolicy } from '../../src/main/services/recycleBinService';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-long-trash-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function createDeepFile(root: string): string {
  let dir = root;
  while (dir.length < 240) dir = path.join(dir, 'segment-0123456789');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'deep-long-name-file.txt');
  fs.writeFileSync(file, 'long-path-content');
  return file;
}

function makeService(root: string, deps: Partial<LongTrashDeps> = {}): LongTrashService {
  return new LongTrashService({
    rootDir: path.join(root, 'appdata'),
    trashRoot: () => path.join(root, 'trash'),
    now: () => 7000,
    ...deps,
  });
}

describe('long path quarantine', () => {
  it('moves the file out of the tree, records it and restores it', async () => {
    const root = tempRoot();
    const deepFile = createDeepFile(root);
    expect(deepFile.length).toBeGreaterThanOrEqual(LONG_PATH_LIMIT);
    const service = makeService(root);
    expect(service.needsQuarantine(deepFile)).toBe(true);
    expect(service.needsQuarantine(path.join(root, 'short.txt'))).toBe(false);

    const entry = await service.quarantine(deepFile, { size: 17, name: 'deep-long-name-file.txt' });
    expect(fs.existsSync(deepFile)).toBe(false);
    expect(fs.existsSync(entry.storedPath)).toBe(true);
    expect(entry).toMatchObject({
      originalPath: deepFile,
      drive: 'C:',
      size: 17,
    });

    const reloaded = makeService(root).list();
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.totalBytes).toBe(17);
    expect(reloaded.manifestPath).toBe(path.join(root, 'appdata', 'long-trash.json'));

    const restored = await service.restore(entry.id);
    expect(restored).toEqual({ ok: true, error: null });
    expect(fs.readFileSync(deepFile, 'utf8')).toBe('long-path-content');
    expect(makeService(root).list().entries).toHaveLength(0);
  });

  it('refuses to overwrite a file that reappeared at the original path', async () => {
    const root = tempRoot();
    const deepFile = createDeepFile(root);
    const service = makeService(root);
    const entry = await service.quarantine(deepFile);
    fs.writeFileSync(deepFile, 'rewritten');

    const restored = await service.restore(entry.id);
    expect(restored.ok).toBe(false);
    expect(restored.error).toContain('同名文件');
    expect(fs.readFileSync(deepFile, 'utf8')).toBe('rewritten');
    expect(fs.existsSync(entry.storedPath)).toBe(true);
    expect(service.list().entries).toHaveLength(1);
  });

  it('reports unknown ids without touching the manifest', async () => {
    const root = tempRoot();
    const service = makeService(root);
    await expect(
      service.restore('00000000-0000-4000-8000-000000000000'),
    ).resolves.toEqual({ ok: false, error: '回收区中没有这条记录' });
  });
});

interface Seeded {
  db: DatabaseSync;
  scanId: number;
  root: string;
  deepFile: string;
  normalFile: string;
  deepId: number;
  normalId: number;
}

function insertFile(db: DatabaseSync, scanId: number, filePath: string): number {
  const name = path.win32.basename(filePath);
  const dirPath = path.win32.dirname(filePath);
  const rootDir = path.win32.basename(dirPath);
  const stats = fs.statSync(filePath, { bigint: true });
  const result = db
    .prepare(
      `INSERT INTO files
        (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scanId,
      'C:',
      filePath,
      normalizePathKey(filePath),
      name,
      name.toLowerCase(),
      getExtension(name),
      classifyFileName(name),
      Number(stats.size),
      Number(stats.mtimeMs),
      Number(stats.mtimeMs),
      rootDir,
      dirPath,
      normalizePathKey(dirPath),
      stats.dev.toString(16),
      stats.ino.toString(16),
    );
  return Number(result.lastInsertRowid);
}

function seed(): Seeded {
  const temp = createTempDbPath('disk-organizer-long-trash-db-');
  cleanups.push(temp.cleanup);
  const root = tempRoot();
  const db = openDatabase(temp.dbPath);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // Database may already be closed by a test.
    }
  });
  const deepFile = createDeepFile(root);
  const normalFile = path.join(root, 'normal.txt');
  fs.writeFileSync(normalFile, 'normal-content');

  const scanId = createScan(db, ['C:'], 1000);
  const deepId = insertFile(db, scanId, deepFile);
  const normalId = insertFile(db, scanId, normalFile);
  finalizeScan(db, scanId, {
    totalFiles: 2,
    identifiedBytes: fs.statSync(deepFile).size + fs.statSync(normalFile).size,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);
  return { db, scanId, root, deepFile, normalFile, deepId, normalId };
}

function policy(): RecycleBinPolicy {
  return {
    available: true,
    blockReason: null,
    volumeGuid: '\\\\?\\Volume{test}\\',
    noRecycleFiles: false,
    nukeOnDelete: false,
    configuredMaxCapacityMB: null,
    maxCapacityBytes: 64 * 1024 * 1024,
    defaultCapacityUsed: true,
  };
}

describe('delete service with long paths', () => {
  it('routes long paths to the app recycle area and removes them from the index', async () => {
    const { db, root, deepFile, normalFile, deepId, normalId } = seed();
    try {
      const longTrash = makeService(root, { now: () => 9000 });
      const trashed: string[] = [];
      const service = new DeleteService({
        db,
        getRecyclePolicy: () => policy(),
        trashItem: async (filePath) => {
          trashed.push(filePath);
          fs.rmSync(filePath, { force: true });
        },
        longTrash,
        now: () => 5000,
      });

      const deepSize = fs.statSync(deepFile).size;
      const preview = service.preview([deepId, normalId]);
      expect(preview.okCount).toBe(1);
      expect(preview.longPathCount).toBe(1);
      expect(preview.longPathBytes).toBe(deepSize);
      expect(preview.canDelete).toBe(true);

      service.start([deepId, normalId]);
      await service.whenIdle();

      expect(trashed).toEqual([normalFile]);
      expect(fs.existsSync(deepFile)).toBe(false);
      expect(fs.existsSync(normalFile)).toBe(false);
      const state = service.getState();
      expect(state.result).toMatchObject({
        succeeded: 2,
        failed: 0,
        quarantined: 1,
        stopped: false,
      });
      expect(state.result?.quarantineBytes).toBe(deepSize);
      const rows = db.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number };
      expect(rows.count).toBe(0);

      const entry = longTrash.list().entries[0];
      expect(entry.originalPath).toBe(deepFile);
      const restored = await longTrash.restore(entry.id);
      expect(restored.ok).toBe(true);
      expect(fs.readFileSync(deepFile, 'utf8')).toBe('long-path-content');
    } finally {
      db.close();
    }
  });

  it('keeps long paths in the index when the recycle area is unavailable', async () => {
    const { db, deepFile, deepId } = seed();
    try {
      const service = new DeleteService({
        db,
        getRecyclePolicy: () => policy(),
        trashItem: async () => undefined,
        now: () => 5000,
      });
      const preview = service.preview([deepId]);
      expect(preview.okCount).toBe(0);
      expect(preview.longPathCount).toBe(0);
      expect(preview.blockedCount).toBe(1);
      expect(preview.canDelete).toBe(false);
      expect(preview.recycleMessage).toContain('260');
      expect(fs.existsSync(deepFile)).toBe(true);
      const rows = db.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number };
      expect(rows.count).toBe(2);
    } finally {
      db.close();
    }
  });
});
