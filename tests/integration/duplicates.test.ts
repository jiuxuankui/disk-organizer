import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DuplicateQuery } from '@shared/types';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import { openDatabase } from '../../src/main/db/connection';
import {
  createScan,
  finalizeScan,
  markOtherDuplicateRunsStale,
  setActiveScanId,
} from '../../src/main/db/scansRepo';
import { normalizePathKey } from '../../src/main/services/filesystem';
import { DuplicatesService } from '../../src/main/services/duplicatesService';
import { listDuplicateCandidates } from '../../src/main/db/duplicatesRepo';
import {
  createInlineHashRunner,
  HashCancelledError,
  type HashRunner,
} from '../../src/main/services/hashRunner';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface FixtureFile {
  path: string;
  size: number;
  mtimeMs: number;
  volumeId: string;
  fileId: string;
  drive: string;
}

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-dup-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function createFile(
  root: string,
  relative: string,
  content: Buffer,
  mtimeMs: number,
  drive = 'C:',
): FixtureFile {
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
    volumeId: stats.dev.toString(16),
    fileId: stats.ino.toString(16),
    drive,
  };
}

function insertFile(db: DatabaseSync, scanId: number, file: FixtureFile): number {
  const name = path.win32.basename(file.path);
  const dirPath = path.win32.dirname(file.path);
  const rootDir = path.win32.basename(dirPath);
  const result = db
    .prepare(
      `INSERT INTO files
        (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scanId,
      file.drive,
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
      file.volumeId,
      file.fileId,
    );
  return Number(result.lastInsertRowid);
}

interface Seeded {
  db: DatabaseSync;
  service: DuplicatesService;
  scanId: number;
  files: Record<string, FixtureFile>;
}

function seed(): Seeded {
  const temp = createTempDbPath();
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

  const shared = Buffer.alloc(70_000, 0x41);
  const different = Buffer.alloc(70_000, 0x42);
  const mixed = Buffer.alloc(80 * 1024, 0x4d);
  const hardLinked = Buffer.alloc(72 * 1024, 0x48);
  const cross = Buffer.alloc(70 * 1024, 0x58);

  const files: Record<string, FixtureFile> = {};
  files.sameA = createFile(root, 'a\\same-a.txt', shared, Date.UTC(2020, 0, 1));
  files.sameB = createFile(root, 'bb\\same-b.txt', shared, Date.UTC(2024, 0, 1));
  files.sameC = createFile(root, 'cc\\same-c.txt', shared, Date.UTC(2024, 0, 1));
  files.different = createFile(root, 'diff.txt', different, Date.UTC(2023, 0, 1));
  files.mixedJpg = createFile(root, 'mixed\\mixed-a.jpg', mixed, Date.UTC(2022, 0, 1));
  files.mixedPng = createFile(root, 'mixed\\mixed-b.png', mixed, Date.UTC(2022, 0, 2));
  files.crossC = createFile(root, 'cross\\cross-c.bin', cross, Date.UTC(2021, 0, 1), 'C:');
  files.crossX = createFile(root, 'cross\\cross-x.bin', cross, Date.UTC(2021, 0, 2), 'X:');
  files.hardA = createFile(root, 'hard\\hard-a.bin', hardLinked, Date.UTC(2022, 5, 1));
  fs.linkSync(files.hardA.path, path.join(root, 'hard\\hard-b.bin'));
  const hardBStats = fs.statSync(path.join(root, 'hard\\hard-b.bin'), { bigint: true });
  files.hardB = {
    path: path.join(root, 'hard\\hard-b.bin'),
    size: Number(hardBStats.size),
    mtimeMs: Number(hardBStats.mtimeMs),
    volumeId: hardBStats.dev.toString(16),
    fileId: hardBStats.ino.toString(16),
    drive: 'C:',
  };
  files.zeroA = createFile(root, 'zero\\zero-a.bin', Buffer.alloc(0), Date.UTC(2020, 0, 1));
  files.zeroB = createFile(root, 'zero\\zero-b.bin', Buffer.alloc(0), Date.UTC(2020, 0, 1));

  const scanId = createScan(db, ['C:', 'X:'], 1000);
  let totalFiles = 0;
  let totalBytes = 0;
  for (const file of Object.values(files)) {
    insertFile(db, scanId, file);
    totalFiles += 1;
    totalBytes += file.size;
  }
  finalizeScan(db, scanId, {
    totalFiles,
    identifiedBytes: totalBytes,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);

  const service = new DuplicatesService({
    db,
    getDefaultMinSize: () => 0,
    runnerFactory: () => createInlineHashRunner(),
  });

  return { db, service, scanId, files };
}

async function runToCompletion(service: DuplicatesService): Promise<void> {
  service.start();
  await service.whenIdle();
}

function baseQuery(patch: Partial<DuplicateQuery> = {}): DuplicateQuery {
  return {
    minSize: 0,
    drive: null,
    type: null,
    sortBy: 'reclaimable',
    sortOrder: 'desc',
    page: 1,
    pageSize: 100,
    ...patch,
  };
}

describe('duplicate detection', () => {
  it('groups identical content, ignores same-size differences and zero-byte files', async () => {
    const { db, service, files } = seed();
    try {
      await runToCompletion(service);
      const state = service.getState();
      expect(state.status).toBe('completed');
      expect(state.groups).toBe(3);
      expect(state.files).toBe(7);
      expect(state.reclaimableBytes).toBe(140_000 + 81_920 + 71_680);

      const page = service.query(baseQuery());
      expect(page.total).toBe(3);
      const sameGroup = page.items.find((group) => group.size === 70_000);
      expect(sameGroup).toBeDefined();
      expect(sameGroup!.fileCount).toBe(3);
      expect(sameGroup!.reclaimableBytes).toBe(140_000);
      expect(sameGroup!.members.map((member) => member.name).sort()).toEqual([
        'same-a.txt',
        'same-b.txt',
        'same-c.txt',
      ]);
      expect(sameGroup!.members.some((member) => member.name === 'diff.txt')).toBe(false);
      const keep = sameGroup!.members.find((member) => member.suggestedKeep);
      expect(keep?.name).toBe('same-a.txt');
      expect(keep?.path).toBe(files.sameA.path);

      const mixedGroup = page.items.find((group) => group.extensions.length === 2);
      expect(mixedGroup).toBeDefined();
      expect(mixedGroup!.mixedExt).toBe(true);
      expect(mixedGroup!.extensions.sort()).toEqual(['jpg', 'png']);

      const crossGroup = page.items.find((group) => group.drives.length === 2);
      expect(crossGroup).toBeDefined();
      expect(crossGroup!.drives).toEqual(['C:', 'X:']);

      const zeroFileIds = new Set(
        page.items.flatMap((group) => group.members.map((member) => member.path)),
      );
      expect(zeroFileIds.has(files.zeroA.path)).toBe(false);
      expect(zeroFileIds.has(files.zeroB.path)).toBe(false);

      const hardlinkPaths = new Set(
        page.items.flatMap((group) => group.members.map((member) => member.path)),
      );
      expect(hardlinkPaths.has(files.hardA.path)).toBe(false);
      expect(hardlinkPaths.has(files.hardB.path)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('filters groups by drive, type and minimum size, and restores when cleared', async () => {
    const { db, service } = seed();
    try {
      await runToCompletion(service);
      const all = service.query(baseQuery());
      expect(all.total).toBe(3);

      const xDrive = service.query(baseQuery({ drive: 'X:' }));
      expect(xDrive.total).toBe(1);
      expect(xDrive.items[0].drives).toContain('X:');

      const images = service.query(baseQuery({ type: 'image' }));
      expect(images.total).toBe(1);
      expect(images.items[0].extensions.sort()).toEqual(['jpg', 'png']);

      const large = service.query(baseQuery({ minSize: 75_000 }));
      expect(large.total).toBe(1);
      expect(large.items[0].size).toBe(81_920);

      const restored = service.query(baseQuery({ minSize: 0 }));
      expect(restored.total).toBe(3);
      expect(restored.totalFiles).toBe(7);
      expect(restored.reclaimableBytes).toBe(293_600);
    } finally {
      db.close();
    }
  });

  it('lists duplicate candidates only from the selected drives', () => {
    const { db, scanId, files } = seed();
    try {
      const allPaths = new Set(listDuplicateCandidates(db, scanId, 0).map((row) => row.path));
      expect(allPaths.has(files.crossX.path)).toBe(true);

      const cOnly = listDuplicateCandidates(db, scanId, 0, ['C:']);
      expect(cOnly.length).toBeGreaterThan(0);
      expect(cOnly.every((row) => row.drive === 'C:')).toBe(true);
      const cPaths = new Set(cOnly.map((row) => row.path));
      expect(cPaths.has(files.sameA.path)).toBe(true);
      expect(cPaths.has(files.crossX.path)).toBe(false);

      expect(listDuplicateCandidates(db, scanId, 0, ['X:'])).toHaveLength(0);
      expect(listDuplicateCandidates(db, scanId, 0, [])).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('limits the search to the selected drives and persists the scope', async () => {
    const { db, service, scanId } = seed();
    try {
      const pairSize = 90 * 1024;
      const pair = Buffer.alloc(pairSize, 0x51);
      insertFile(
        db,
        scanId,
        createFile(tempRoot(), 'xpair\\x-pair-a.pdf', pair, Date.UTC(2020, 2, 1), 'X:'),
      );
      insertFile(
        db,
        scanId,
        createFile(tempRoot(), 'xpair\\x-pair-b.pdf', pair, Date.UTC(2020, 2, 2), 'X:'),
      );

      service.start(['X:']);
      await service.whenIdle();
      let state = service.getState();
      expect(state.status).toBe('completed');
      expect(state.drives).toEqual(['X:']);
      let page = service.query(baseQuery());
      expect(page.total).toBe(1);
      expect(page.items[0].size).toBe(pairSize);
      expect(page.items[0].drives).toEqual(['X:']);

      const restarted = new DuplicatesService({
        db,
        getDefaultMinSize: () => 0,
        runnerFactory: () => createInlineHashRunner(),
      });
      expect(restarted.getState().drives).toEqual(['X:']);

      service.start(['c:']);
      await service.whenIdle();
      state = service.getState();
      expect(state.drives).toEqual(['C:']);
      page = service.query(baseQuery());
      expect(page.total).toBe(2);
      expect(page.items.every((group) => group.drives.every((drive) => drive === 'C:'))).toBe(
        true,
      );
      expect(page.items.some((group) => group.size === pairSize)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rejects drives outside the scan and empty selections', () => {
    const { db, service } = seed();
    try {
      expect(() => service.start([])).toThrow('请至少选择一块硬盘');
      expect(() => service.start(['Z:'])).toThrow('本次扫描范围');
      expect(service.getState().status).toBe('idle');
      const runs = db.prepare('SELECT COUNT(*) AS count FROM duplicate_runs').get() as {
        count: number;
      };
      expect(runs.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('recomputes groups and totals after duplicate members are removed', async () => {
    const { db, service } = seed();
    try {
      await runToCompletion(service);
      const before = service.query(baseQuery());
      const sameGroup = before.items.find((group) => group.size === 70_000)!;
      const removeFirst = sameGroup.members.find((member) => member.name === 'same-b.txt')!;
      const removeSecond = sameGroup.members.find((member) => member.name === 'same-c.txt')!;

      expect(service.removeFiles([removeFirst.fileId])).toBe(1);
      const afterFirst = service.query(baseQuery());
      const reduced = afterFirst.items.find((group) => group.size === 70_000)!;
      expect(reduced.fileCount).toBe(2);
      expect(reduced.reclaimableBytes).toBe(70_000);
      expect(reduced.members.map((member) => member.name).sort()).toEqual([
        'same-a.txt',
        'same-c.txt',
      ]);
      expect(reduced.members.find((member) => member.suggestedKeep)?.name).toBe('same-a.txt');
      let state = service.getState();
      expect(state.groups).toBe(3);
      expect(state.files).toBe(6);
      expect(state.reclaimableBytes).toBe(223_600);

      expect(service.removeFiles([removeSecond.fileId])).toBe(1);
      const afterSecond = service.query(baseQuery());
      expect(afterSecond.items.some((group) => group.size === 70_000)).toBe(false);
      expect(afterSecond.total).toBe(2);
      state = service.getState();
      expect(state.groups).toBe(2);
      expect(state.files).toBe(4);
      expect(state.reclaimableBytes).toBe(153_600);
    } finally {
      db.close();
    }
  });

  it('reuses cached hashes on a repeat run', async () => {
    const { db, scanId, service } = seed();
    try {
      await runToCompletion(service);
      const emitted: Array<{
        status: string;
        quickTotal: number;
        fullTotal: number;
        groups: number;
      }> = [];
      let calls = 0;
      const inline = createInlineHashRunner();
      const counting: HashRunner = {
        async run(items, options) {
          calls += items.length;
          return inline.run(items, options);
        },
        async dispose() {
          // no-op
        },
      };
      const second = new DuplicatesService({
        db,
        getDefaultMinSize: () => 0,
        runnerFactory: () => counting,
        emit: (state) =>
          emitted.push({
            status: state.status,
            quickTotal: state.quickTotal,
            fullTotal: state.fullTotal,
            groups: state.groups,
          }),
      });
      await runToCompletion(second);
      expect(second.getState().status).toBe('completed');
      expect(calls).toBe(0);
      expect(emitted.some((state) => state.status === 'running' && state.quickTotal > 0)).toBe(
        true,
      );
      expect(emitted.some((state) => state.status === 'completed' && state.groups > 0)).toBe(
        true,
      );
      expect(second.query(baseQuery()).total).toBe(3);
      expect(scanId).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('cancels without leaving partial groups', async () => {
    const { db } = seed();
    try {
      const blocking: HashRunner = {
        run(_items, options) {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new HashCancelledError()));
          });
        },
        async dispose() {
          // no-op
        },
      };
      const cancellable = new DuplicatesService({
        db,
        getDefaultMinSize: () => 0,
        runnerFactory: () => blocking,
      });
      cancellable.start();
      expect(cancellable.getState().status).toBe('running');
      cancellable.cancel();
      await cancellable.whenIdle();
      expect(cancellable.getState().status).toBe('cancelled');

      const groups = db.prepare('SELECT COUNT(*) AS count FROM duplicate_groups').get() as {
        count: number;
      };
      expect(groups.count).toBe(0);
      expect(cancellable.query(baseQuery()).total).toBe(0);
      const run = db
        .prepare('SELECT status, total_groups FROM duplicate_runs ORDER BY id DESC LIMIT 1')
        .get() as { status: string; total_groups: number };
      expect(run).toEqual({ status: 'cancelled', total_groups: 0 });
    } finally {
      db.close();
    }
  });

  it('flags results as stale after a newer scan invalidates the index', async () => {
    const { db, service, scanId } = seed();
    try {
      await runToCompletion(service);
      expect(service.query(baseQuery()).total).toBe(3);
      markOtherDuplicateRunsStale(db, scanId + 100);
      const state = service.getState();
      expect(state.status).toBe('stale');
      expect(state.needsRefresh).toBe(true);
      expect(state.groups).toBe(0);
      expect(service.query(baseQuery()).total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps the earliest modification time as the suggested copy', async () => {
    const { db, service } = seed();
    try {
      await runToCompletion(service);
      const page = service.query(baseQuery());
      for (const group of page.items) {
        const keeps = group.members.filter((member) => member.suggestedKeep);
        expect(keeps).toHaveLength(1);
        const earliest = Math.min(...group.members.map((member) => member.mtimeMs));
        expect(keeps[0].mtimeMs).toBe(earliest);
      }
    } finally {
      db.close();
    }
  });
});
