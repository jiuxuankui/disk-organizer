import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/main/db/connection';
import { createScan } from '../../src/main/db/scansRepo';
import {
  defaultScanFsOps,
  runScanCore,
  ScanCancelledError,
  type ScanControl,
  type ScanCoreOptions,
  type ScanFsOps,
} from '../../src/main/workers/scanCore';
import { toExtendedPath } from '../../src/main/services/filesystem';
import { createScanFixture, createTempDbPath, type ScanFixture } from './helpers';

interface FileRow {
  path: string;
  path_key: string;
  name: string;
  ext: string;
  type: string;
  size: number;
  root_dir: string;
  dir_path: string;
  volume_id: string;
  file_id: string;
}

interface ScanContext {
  db: DatabaseSync;
  scanId: number;
  cleanup(): void;
}

const cleanups: Array<() => void> = [];
let fixture: ScanFixture;

beforeAll(() => {
  fixture = createScanFixture();
});

afterAll(() => {
  fixture.cleanup();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function createContext(): ScanContext {
  const temp = createTempDbPath('disk-organizer-scan-db-');
  const db = openDatabase(temp.dbPath);
  const scanId = createScan(db, [fixture.root], Date.now());
  cleanups.push(() => {
    db.close();
    temp.cleanup();
  });
  return { db, scanId, cleanup: temp.cleanup };
}

function optionsFor(scanId: number, overrides: Partial<ScanCoreOptions> = {}): ScanCoreOptions {
  return {
    scanId,
    drives: [fixture.root],
    excludedPaths: [fixture.excludedDir],
    skipHiddenSystem: true,
    batchSize: 2,
    ...overrides,
  };
}

function getFiles(db: DatabaseSync, scanId: number): FileRow[] {
  return db
    .prepare('SELECT * FROM files WHERE scan_id = ? ORDER BY path_key')
    .all(scanId) as unknown as FileRow[];
}

describe('two-phase scan', () => {
  it('indexes the fixture with types, sizes, roots, and skip reasons', async () => {
    const { db, scanId } = createContext();
    const phases: string[] = [];
    const progress: Array<{ found: number; processed: number }> = [];
    const result = await runScanCore(
      db,
      optionsFor(scanId),
      { paused: false, cancelled: false },
      {
        onPhase: (phase) => phases.push(phase),
        onProgress: (value) =>
          progress.push({ found: value.filesFound, processed: value.filesProcessed }),
      },
    );

    expect(phases).toEqual(['enumerating', 'indexing']);
    expect(result.totalFiles).toBe(8);
    expect(result.identifiedBytes).toBe(fixture.expectedBytes);
    expect(progress.length).toBeGreaterThan(0);

    const files = getFiles(db, scanId);
    expect(files).toHaveLength(8);
    expect(files.map((file) => file.path.toLowerCase()).sort()).toEqual(
      fixture.expectedFiles.map((file) => file.toLowerCase()).sort(),
    );

    const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
    expect(byName.get('a.txt')?.type).toBe('document');
    expect(byName.get('a.txt')?.root_dir).toBe('docs');
    expect(byName.get('a.txt')?.dir_path.toLowerCase()).toBe(
      path.join(fixture.root, 'docs').toLowerCase(),
    );
    expect(byName.get('b.pdf')?.type).toBe('document');
    expect(byName.get('video.mp4')?.type).toBe('video');
    expect(byName.get('photo.jpg')?.type).toBe('image');
    expect(byName.get('photo.jpg')?.root_dir).toBe('media');
    expect(byName.get('zero.bin')?.size).toBe(0);
    expect(byName.get('zero.bin')?.type).toBe('program');
    expect(byName.get('readme')?.type).toBe('other');
    expect(byName.get('readme')?.ext).toBe('');
    expect(byName.get('zero.bin')?.root_dir).toBe('');
    expect(byName.get('my$recycle.bin note.txt')?.type).toBe('document');

    for (const file of files) {
      expect(file.path_key).toBe(file.path.toLowerCase());
      expect(file.volume_id.length).toBeGreaterThan(0);
      expect(file.file_id.length).toBeGreaterThan(0);
    }
    expect(byName.get('link.txt')?.volume_id).toBe(byName.get('a.txt')?.volume_id);
    expect(byName.get('link.txt')?.file_id).toBe(byName.get('a.txt')?.file_id);

    const staging = db
      .prepare('SELECT COUNT(*) AS c FROM scan_staging WHERE scan_id = ?')
      .get(scanId) as { c: number };
    expect(staging.c).toBe(8);

    const skipped = new Map(result.skipped.map((item) => [item.reason, item]));
    expect(skipped.get('excluded')?.count).toBe(3);
    expect(skipped.get('hidden')?.count).toBe(1);
    expect(skipped.get('system')?.count).toBe(1);
    expect(skipped.get('special')?.count).toBe(1);
    expect(skipped.get('permission')).toBeUndefined();
    const excludedSamples = skipped.get('excluded')!.samples.map((sample) => sample.toLowerCase());
    expect(excludedSamples).toEqual(
      expect.arrayContaining([
        fixture.excludedDir.toLowerCase(),
        path.join(fixture.root, '$Recycle.Bin').toLowerCase(),
        path.join(fixture.root, 'System Volume Information').toLowerCase(),
      ]),
    );
    expect(skipped.get('special')!.samples[0].toLowerCase()).toBe(
      fixture.junctionPath.toLowerCase(),
    );

    const paths = files.map((file) => file.path.toLowerCase());
    expect(paths).not.toContain(fixture.hiddenFile.toLowerCase());
    expect(paths).not.toContain(fixture.systemFile.toLowerCase());
  });

  it('never writes to the scanned files', async () => {
    const before = fixture.snapshot();
    const { db, scanId } = createContext();
    await runScanCore(db, optionsFor(scanId), { paused: false, cancelled: false });
    const after = fixture.snapshot();
    expect(after).toEqual(before);
  });

  it('pauses and resumes without restarting the scan', async () => {
    const { db, scanId } = createContext();
    const control: ScanControl = { paused: true, cancelled: false };
    let pauses = 0;
    const result = await runScanCore(db, optionsFor(scanId, { batchSize: 3 }), control, {
      onPaused() {
        pauses += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            control.paused = false;
            resolve();
          }, 20);
        });
      },
    });
    expect(pauses).toBe(1);
    expect(result.totalFiles).toBe(8);
  });

  it('observes a pause requested asynchronously while the scan runs', async () => {
    const { db, scanId } = createContext();
    const control: ScanControl = { paused: false, cancelled: false };
    let pauses = 0;
    const timer = setTimeout(() => {
      control.paused = true;
    }, 0);
    const result = await runScanCore(db, optionsFor(scanId, { batchSize: 2 }), control, {
      onPaused() {
        pauses += 1;
        control.paused = false;
        return Promise.resolve();
      },
    });
    clearTimeout(timer);
    expect(pauses).toBe(1);
    expect(result.totalFiles).toBe(8);
  });

  it('stops mid indexing when cancelled and leaves only partial rows', async () => {
    const { db, scanId } = createContext();
    const control: ScanControl = { paused: false, cancelled: false };
    let lstatCount = 0;
    const fsOps: ScanFsOps = {
      ...defaultScanFsOps,
      lstat(filePath) {
        const stats = defaultScanFsOps.lstat(filePath);
        lstatCount += 1;
        if (lstatCount === 4) control.cancelled = true;
        return stats;
      },
    };

    await expect(
      runScanCore(db, optionsFor(scanId, { fsOps }), control),
    ).rejects.toBeInstanceOf(ScanCancelledError);

    const files = getFiles(db, scanId);
    const staging = db
      .prepare('SELECT COUNT(*) AS c FROM scan_staging WHERE scan_id = ?')
      .get(scanId) as { c: number };
    expect(staging.c).toBe(8);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(8);
  });

  it('records permission failures and keeps scanning the rest', async () => {
    const { db, scanId } = createContext();
    const docs = path.join(fixture.root, 'docs');
    const fsOps: ScanFsOps = {
      ...defaultScanFsOps,
      readdir(dirPath) {
        if (dirPath.toLowerCase() === docs.toLowerCase()) {
          const error = new Error('拒绝访问') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return defaultScanFsOps.readdir(dirPath);
      },
    };
    const result = await runScanCore(db, optionsFor(scanId, { fsOps }), {
      paused: false,
      cancelled: false,
    });
    expect(result.totalFiles).toBe(6);
    const permission = result.skipped.find((item) => item.reason === 'permission');
    expect(permission?.count).toBe(1);
    expect(permission?.samples[0].toLowerCase()).toBe(docs.toLowerCase());
    const files = getFiles(db, scanId);
    expect(files.some((file) => file.root_dir === 'docs')).toBe(false);
  });

  it('indexes files whose full path exceeds 260 characters', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-scan-long-'));
    cleanups.push(() => fs.rmSync(toExtendedPath(base), { recursive: true, force: true }));
    let current = base;
    const firstSegment = `segment-0-${'x'.repeat(30)}`;
    for (let index = 0; index < 8; index += 1) {
      current = path.join(current, `segment-${index}-${'x'.repeat(30)}`);
    }
    fs.mkdirSync(toExtendedPath(current), { recursive: true });
    const deepFile = path.join(current, 'deep.txt');
    fs.writeFileSync(toExtendedPath(deepFile), 'deep-content');
    expect(deepFile.length).toBeGreaterThan(260);

    const { db, scanId } = createContext();
    const result = await runScanCore(
      db,
      optionsFor(scanId, { drives: [base], excludedPaths: [] }),
      { paused: false, cancelled: false },
    );

    expect(result.totalFiles).toBe(1);
    const files = getFiles(db, scanId);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(deepFile);
    expect(files[0].size).toBe(12);
    expect(files[0].root_dir).toBe(firstSegment);
  });

  it('includes hidden and system files when the skip option is off', async () => {
    const { db, scanId } = createContext();
    const result = await runScanCore(
      db,
      optionsFor(scanId, { skipHiddenSystem: false }),
      { paused: false, cancelled: false },
    );
    expect(result.totalFiles).toBe(10);
    const files = getFiles(db, scanId);
    const paths = files.map((file) => file.path.toLowerCase());
    expect(paths).toContain(fixture.hiddenFile.toLowerCase());
    expect(paths).toContain(fixture.systemFile.toLowerCase());
    const skipped = new Map(result.skipped.map((item) => [item.reason, item]));
    expect(skipped.get('hidden')).toBeUndefined();
    expect(skipped.get('system')).toBeUndefined();
    expect(skipped.get('excluded')?.count).toBe(3);
  });

  it('ignores files whose names merely contain an excluded directory name', async () => {
    const { db, scanId } = createContext();
    await runScanCore(db, optionsFor(scanId), { paused: false, cancelled: false });
    const files = getFiles(db, scanId);
    expect(files.some((file) => file.name.toLowerCase() === 'my$recycle.bin note.txt')).toBe(true);
    expect(fs.existsSync(path.join(fixture.root, 'My$Recycle.Bin note.txt'))).toBe(true);
  });
});
