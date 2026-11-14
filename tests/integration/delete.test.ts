import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteEvent } from '@shared/types';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import { openDatabase } from '../../src/main/db/connection';
import {
  createScan,
  finalizeScan,
  setActiveScanId,
} from '../../src/main/db/scansRepo';
import { normalizePathKey } from '../../src/main/services/filesystem';
import { DeleteService } from '../../src/main/services/deleteService';
import type { RecycleBinPolicy } from '../../src/main/services/recycleBinService';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-delete-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

interface SeededFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function createFile(root: string, relative: string, content: Buffer, mtimeMs: number): SeededFile {
  const fullPath = path.join(root, relative);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(fullPath, seconds, seconds);
  const stats = fs.statSync(fullPath, { bigint: true });
  return {
    path: fullPath,
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

function insertFile(
  db: DatabaseSync,
  scanId: number,
  file: SeededFile,
  drive = 'C:',
): number {
  const name = path.win32.basename(file.path);
  const dirPath = path.win32.dirname(file.path);
  const rootDir = path.win32.basename(dirPath);
  const stats = fs.statSync(file.path, { bigint: true });
  const result = db
    .prepare(
      `INSERT INTO files
        (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scanId,
      drive,
      file.path,
      normalizePathKey(file.path),
      name,
      name.toLowerCase(),
      getExtension(name),
      classifyFileName(name),
      file.size,
      file.mtimeMs,
      file.mtimeMs,
      rootDir,
      dirPath,
      normalizePathKey(dirPath),
      stats.dev.toString(16),
      stats.ino.toString(16),
    );
  return Number(result.lastInsertRowid);
}

interface Seed {
  db: DatabaseSync;
  scanId: number;
  root: string;
  files: Record<'a' | 'b' | 'c' | 'unique', SeededFile>;
  ids: Record<'a' | 'b' | 'c' | 'unique', number>;
}

async function seed(): Promise<Seed> {
  const temp = createTempDbPath('disk-organizer-delete-db-');
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

  const shared = Buffer.alloc(8192, 0x41);
  const unique = Buffer.alloc(4096, 0x55);
  const files = {
    a: createFile(root, 'triple\\a.bin', shared, Date.UTC(2020, 0, 1)),
    b: createFile(root, 'triple\\b.bin', shared, Date.UTC(2021, 0, 1)),
    c: createFile(root, 'triple\\c.bin', shared, Date.UTC(2022, 0, 1)),
    unique: createFile(root, 'other\\unique.bin', unique, Date.UTC(2023, 0, 1)),
  };

  const scanId = createScan(db, ['C:'], 1000);
  let totalFiles = 0;
  let totalBytes = 0;
  const ids = {} as Seed['ids'];
  for (const key of ['a', 'b', 'c', 'unique'] as const) {
    ids[key] = insertFile(db, scanId, files[key]);
    totalFiles += 1;
    totalBytes += files[key].size;
  }
  finalizeScan(db, scanId, {
    totalFiles,
    identifiedBytes: totalBytes,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);

  return { db, scanId, root, files, ids };
}

function policy(patch: Partial<RecycleBinPolicy> = {}): RecycleBinPolicy {
  return {
    available: true,
    blockReason: null,
    volumeGuid: '\\\\?\\Volume{test}\\',
    noRecycleFiles: false,
    nukeOnDelete: false,
    configuredMaxCapacityMB: null,
    maxCapacityBytes: 64 * 1024 * 1024,
    defaultCapacityUsed: true,
    ...patch,
  };
}

function makeService(
  db: DatabaseSync,
  options: {
    policy?: () => RecycleBinPolicy;
    trashItem?: (filePath: string) => Promise<void>;
    concurrency?: number;
    onEvent?: (event: DeleteEvent) => void;
  } = {},
): DeleteService {
  return new DeleteService({
    db,
    getRecyclePolicy: options.policy ?? (() => policy()),
    trashItem:
      options.trashItem ??
      (async (filePath: string) => {
        fs.rmSync(filePath, { force: true });
      }),
    emit: options.onEvent,
    concurrency: options.concurrency,
    now: () => 5000,
  });
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function scanTotals(db: DatabaseSync, scanId: number): { files: number; bytes: number } {
  const row = db
    .prepare('SELECT total_files, identified_bytes FROM scans WHERE id = ?')
    .get(scanId) as { total_files: number; identified_bytes: number };
  return { files: row.total_files, bytes: row.identified_bytes };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('delete preview', () => {
  it('summarizes deletable files and preview names', async () => {
    const { db, ids, files } = await seed();
    try {
      const service = makeService(db);
      const preview = service.preview([ids.a, ids.b, ids.c]);
      expect(preview.total).toBe(3);
      expect(preview.okCount).toBe(3);
      expect(preview.okBytes).toBe(files.a.size * 3);
      expect(preview.missingCount).toBe(0);
      expect(preview.blockedCount).toBe(0);
      expect(preview.previewNames).toHaveLength(3);
      expect(preview.recycleAvailable).toBe(true);
      expect(preview.canDelete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('counts files that vanished from disk as missing but leaves them in the index', async () => {
    const { db, ids } = await seed();
    try {
      fs.rmSync(idsFileOf(ids.a, db), { force: true });
      const preview = makeService(db).preview([ids.a, ids.b]);
      expect(preview.missingCount).toBe(1);
      expect(preview.okCount).toBe(1);
      expect(count(db, 'files')).toBe(4);
    } finally {
      db.close();
    }
  });

  it('blocks files that exceed the remaining recycle bin capacity', async () => {
    const { db, ids, files } = await seed();
    try {
      const service = makeService(db, {
        policy: () => policy({ maxCapacityBytes: Math.floor(files.a.size * 1.5) }),
      });
      const preview = service.preview([ids.a, ids.b, ids.c]);
      expect(preview.okCount).toBe(1);
      expect(preview.blockedCount).toBe(2);
      expect(preview.recycleAvailable).toBe(true);
      expect(preview.canDelete).toBe(true);
      expect(preview.previewNames).toEqual(['a.bin']);
    } finally {
      db.close();
    }
  });

  it('fails closed when the recycle bin is unavailable', async () => {
    const { db, ids } = await seed();
    try {
      const service = makeService(db, {
        policy: () => policy({ available: false, blockReason: 'unavailable', maxCapacityBytes: 0 }),
      });
      const preview = service.preview([ids.a, ids.b]);
      expect(preview.okCount).toBe(0);
      expect(preview.blockedCount).toBe(2);
      expect(preview.canDelete).toBe(false);
      expect(preview.recycleAvailable).toBe(false);
      expect(preview.recycleMessage).toContain('回收站');
    } finally {
      db.close();
    }
  });

  it('reports ids that are not part of the active index', async () => {
    const { db, ids } = await seed();
    try {
      const preview = makeService(db).preview([ids.unique, 999_999]);
      expect(preview.okCount).toBe(1);
      expect(preview.missingCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('exposes per-drive recycle availability', async () => {
    const { db } = await seed();
    try {
      const status = makeService(db, {
        policy: () => policy({ available: false, maxCapacityBytes: 0 }),
      }).status();
      expect(status.available).toBe(false);
      expect(status.reason).toContain('C:');
      expect(status.drives).toEqual([
        {
          drive: 'C:',
          available: false,
          reason: expect.stringContaining('回收站'),
          maxCapacityBytes: 0,
        },
      ]);
    } finally {
      db.close();
    }
  });
});

function idsFileOf(fileId: number, db: DatabaseSync): string {
  const row = db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as {
    path: string;
  };
  return row.path;
}

describe('delete execution', () => {
  it('moves files and updates the index', async () => {
    const { db, scanId, ids, files } = await seed();
    try {
      const events: DeleteEvent[] = [];
      const service = makeService(db, { onEvent: (event) => events.push(event) });
      const before = scanTotals(db, scanId);
      service.start([ids.b]);
      await service.whenIdle();

      expect(fs.existsSync(files.b.path)).toBe(false);
      expect(fs.existsSync(files.c.path)).toBe(true);
      expect(count(db, 'files')).toBe(3);
      expect(scanTotals(db, scanId)).toEqual({
        files: before.files - 1,
        bytes: before.bytes - files.b.size,
      });

      const settled = events.filter((event) => event.type === 'settled');
      expect(settled).toHaveLength(1);
      if (settled[0].type === 'settled') {
        expect(settled[0].result.succeeded).toBe(1);
        expect(settled[0].result.failed).toBe(0);
        expect(settled[0].result.bytes).toBe(files.b.size);
        expect(settled[0].result.stopped).toBe(false);
        expect(settled[0].state.status).toBe('completed');
      }
      expect(service.isRunning()).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps failed files in the index and reports the reason', async () => {
    const { db, ids, files } = await seed();
    try {
      const failing = files.b.path;
      const service = makeService(db, {
        trashItem: async (filePath) => {
          if (filePath === failing) throw new Error('EBUSY: 文件被占用');
          fs.rmSync(filePath, { force: true });
        },
      });
      service.start([ids.a, ids.b, ids.c]);
      await service.whenIdle();

      const state = service.getState();
      expect(state.status).toBe('completed');
      expect(state.result?.succeeded).toBe(2);
      expect(state.result?.failed).toBe(1);
      expect(state.result?.failures[0]).toMatchObject({
        fileId: ids.b,
        path: failing,
        reason: expect.stringContaining('占用'),
      });
      const remaining = db.prepare('SELECT id FROM files ORDER BY id').all() as Array<{
        id: number;
      }>;
      expect(remaining.map((row) => row.id).sort()).toEqual([ids.b, ids.unique].sort());
      expect(fs.existsSync(failing)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('skips missing files at execution time without touching the index row', async () => {
    const { db, ids } = await seed();
    try {
      const missingPath = idsFileOf(ids.a, db);
      fs.rmSync(missingPath, { force: true });
      const service = makeService(db);
      service.start([ids.a, ids.b]);
      await service.whenIdle();
      const state = service.getState();
      expect(state.result?.succeeded).toBe(1);
      expect(state.result?.failed).toBe(1);
      expect(state.result?.failures[0].reason).toContain('不存在');
      const remaining = db.prepare('SELECT id FROM files ORDER BY id').all() as Array<{
        id: number;
      }>;
      expect(remaining.map((row) => row.id)).toContain(ids.a);
    } finally {
      db.close();
    }
  });

  it('stops after the current file when cancelled and reports the partial result', async () => {
    const { db, ids } = await seed();
    try {
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const service = makeService(db, {
        concurrency: 1,
        trashItem: async (filePath) => {
          calls += 1;
          if (calls === 1) await gate;
          fs.rmSync(filePath, { force: true });
        },
      });
      service.start([ids.a, ids.b, ids.c]);
      await waitFor(() => calls === 1);
      service.cancel();
      release!();
      await service.whenIdle();

      const state = service.getState();
      expect(state.status).toBe('completed');
      expect(state.result?.stopped).toBe(true);
      expect(state.result?.succeeded).toBe(1);
      expect(calls).toBe(1);
      expect(count(db, 'files')).toBe(3);
    } finally {
      db.close();
    }
  });

  it('supports deleting a single file', async () => {
    const { db, ids, files } = await seed();
    try {
      const service = makeService(db);
      service.start([ids.a]);
      await service.whenIdle();
      expect(count(db, 'files')).toBe(3);
      expect(fs.existsSync(files.a.path)).toBe(false);
      expect(fs.existsSync(files.b.path)).toBe(true);
      expect(fs.existsSync(files.c.path)).toBe(true);
    } finally {
      db.close();
    }
  });
});
