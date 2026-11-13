import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DriveInfo, FileTypeKey } from '@shared/types';
import { openDatabase } from '../../src/main/db/connection';
import { createScan, finalizeScan, setActiveScanId } from '../../src/main/db/scansRepo';
import {
  buildDriveOverview,
  listTopFiles,
  listTopFolders,
  listTypeUsage,
} from '../../src/main/db/overviewRepo';
import { listDriveSnapshots, saveDriveSnapshots } from '../../src/main/db/drivesRepo';
import { OverviewService } from '../../src/main/services/overviewService';
import type { DrivesService } from '../../src/main/services/drivesService';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDb(): { db: DatabaseSync; cleanup(): void } {
  const temp = createTempDbPath();
  cleanups.push(temp.cleanup);
  return { db: openDatabase(temp.dbPath), cleanup: temp.cleanup };
}

function drive(letter: string, patch: Partial<DriveInfo> = {}): DriveInfo {
  return {
    letter,
    root: `${letter}\\`,
    label: `${letter} 数据`,
    fileSystem: 'NTFS',
    serial: '0001',
    totalBytes: 10000,
    freeBytes: 4000,
    type: 3,
    ready: true,
    ...patch,
  };
}

function insertFile(
  db: DatabaseSync,
  scanId: number,
  path: string,
  size: number,
  type: FileTypeKey,
  mtimeMs = 1000,
): void {
  const driveLetter = path.slice(0, 2).toUpperCase();
  const name = path.slice(path.lastIndexOf('\\') + 1);
  const dirPath = path.slice(0, path.lastIndexOf('\\'));
  const rest = path.slice(3);
  const rootDir = rest.includes('\\') ? rest.slice(0, rest.indexOf('\\')) : '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  db.prepare(
    `INSERT INTO files
      (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
  ).run(
    scanId,
    driveLetter,
    path,
    path.toLowerCase(),
    name,
    name.toLowerCase(),
    ext,
    type,
    size,
    mtimeMs,
    mtimeMs,
    rootDir,
    dirPath,
    dirPath.toLowerCase(),
  );
}

function seedScan(db: DatabaseSync): number {
  const scanId = createScan(db, ['C:', 'D:'], 1000);
  insertFile(db, scanId, 'C:\\Movies\\a.mkv', 500, 'video', 10);
  insertFile(db, scanId, 'C:\\Movies\\b.mp4', 300, 'video', 20);
  insertFile(db, scanId, 'C:\\Pics\\z.jpg', 500, 'image', 30);
  insertFile(db, scanId, 'C:\\Pics\\y.jpg', 100, 'image', 40);
  insertFile(db, scanId, 'C:\\Docs\\c.pdf', 100, 'document', 50);
  insertFile(db, scanId, 'C:\\root.txt', 50, 'document', 60);
  insertFile(db, scanId, 'D:\\Backup\\big.iso', 2000, 'diskImage', 70);
  finalizeScan(db, scanId, {
    totalFiles: 7,
    identifiedBytes: 3550,
    skipped: [{ reason: 'permission', count: 2, samples: ['C:\\Secret'] }],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);
  return scanId;
}

describe('overview repository', () => {
  it('aggregates type usage, top files and first-level folders per drive', () => {
    const { db } = tempDb();
    try {
      const scanId = seedScan(db);

      const types = listTypeUsage(db, scanId, 'C:');
      expect(types).toHaveLength(9);
      expect(types.find((item) => item.type === 'video')).toEqual({
        type: 'video',
        bytes: 800,
        count: 2,
      });
      expect(types.find((item) => item.type === 'image')).toEqual({
        type: 'image',
        bytes: 600,
        count: 2,
      });
      expect(types.find((item) => item.type === 'document')).toEqual({
        type: 'document',
        bytes: 150,
        count: 2,
      });
      expect(types.reduce((sum, item) => sum + item.bytes, 0)).toBe(1550);

      const top = listTopFiles(db, scanId, 'C:');
      expect(top.map((file) => file.path)).toEqual([
        'C:\\Movies\\a.mkv',
        'C:\\Pics\\z.jpg',
        'C:\\Movies\\b.mp4',
        'C:\\Docs\\c.pdf',
        'C:\\Pics\\y.jpg',
        'C:\\root.txt',
      ]);
      expect(top[0].type).toBe('video');
      expect(top.every((file) => file.drive === 'C:')).toBe(true);

      const folders = listTopFolders(db, scanId, 'C:');
      expect(folders).toEqual([
        { path: 'C:\\Movies', name: 'Movies', bytes: 800, count: 2 },
        { path: 'C:\\Pics', name: 'Pics', bytes: 600, count: 2 },
        { path: 'C:\\Docs', name: 'Docs', bytes: 100, count: 1 },
      ]);

      const view = buildDriveOverview(db, scanId, drive('C:'));
      expect(view.identifiedBytes).toBe(1550);
      expect(view.unidentifiedBytes).toBe(6000 - 1550);
      expect(view.fileCount).toBe(6);
      expect(view.online).toBe(true);
      expect(view.label).toBe('C: 数据');
    } finally {
      db.close();
    }
  });

  it('limits the top lists and isolates drives', () => {
    const { db } = tempDb();
    try {
      const scanId = createScan(db, ['C:'], 1000);
      const big = drive('C:');
      for (let i = 0; i < 15; i += 1) {
        insertFile(db, scanId, `C:\\Folder${i}\\file${i}.bin`, 100 + i, 'other');
      }
      const topFiles = listTopFiles(db, scanId, big.letter);
      expect(topFiles).toHaveLength(10);
      expect(topFiles[0].size).toBe(114);
      expect(topFiles[9].size).toBe(105);
      const folders = listTopFolders(db, scanId, big.letter);
      expect(folders).toHaveLength(10);
      expect(folders[0].path).toBe('C:\\Folder14');
    } finally {
      db.close();
    }
  });

  it('returns empty aggregates before the first scan', () => {
    const { db } = tempDb();
    try {
      const view = buildDriveOverview(db, null, drive('C:'));
      expect(view).toMatchObject({
        drive: 'C:',
        identifiedBytes: 0,
        unidentifiedBytes: 6000,
        fileCount: 0,
      });
      expect(view.typeUsage).toHaveLength(9);
      expect(view.typeUsage.every((item) => item.bytes === 0)).toBe(true);
      expect(view.topFiles).toEqual([]);
      expect(view.topFolders).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('never reports negative unidentified size', () => {
    const { db } = tempDb();
    try {
      const scanId = createScan(db, ['C:'], 1000);
      insertFile(db, scanId, 'C:\\big.bin', 9000, 'other');
      finalizeScan(db, scanId, {
        totalFiles: 1,
        identifiedBytes: 9000,
        skipped: [],
        finishedAt: 2000,
      });
      const view = buildDriveOverview(db, scanId, drive('C:', { totalBytes: 1000, freeBytes: 0 }));
      expect(view.unidentifiedBytes).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('drive snapshots', () => {
  it('keeps previously seen drives and marks them offline', () => {
    const { db } = tempDb();
    try {
      saveDriveSnapshots(db, [drive('C:'), drive('D:', { freeBytes: 1000 })], 1000);
      expect(listDriveSnapshots(db).map((item) => item.letter)).toEqual(['C:', 'D:']);

      saveDriveSnapshots(db, [drive('C:')], 2000);
      const snapshots = listDriveSnapshots(db);
      expect(snapshots).toHaveLength(2);
      const d = snapshots.find((item) => item.letter === 'D:');
      expect(d?.ready).toBe(false);
      expect(d?.freeBytes).toBe(1000);
      expect(d?.label).toBe('D: 数据');
      expect(snapshots.find((item) => item.letter === 'C:')?.ready).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('OverviewService', () => {
  it('shows live drives plus scanned drives that are now offline', () => {
    const { db } = tempDb();
    try {
      saveDriveSnapshots(db, [drive('C:'), drive('D:')], 500);
      seedScan(db);
      const fakeDrives = {
        refresh: () => [drive('C:', { freeBytes: 2000 })],
      } as unknown as DrivesService;
      const service = new OverviewService({ db, drives: fakeDrives, now: () => 5000 });
      const overview = service.get();

      expect(overview.scan?.totalFiles).toBe(7);
      expect(overview.totalIdentifiedBytes).toBe(3550);
      expect(overview.drives.map((item) => item.drive)).toEqual(['C:', 'D:']);
      const c = overview.drives[0];
      const d = overview.drives[1];
      expect(c.online).toBe(true);
      expect(c.freeBytes).toBe(2000);
      expect(c.identifiedBytes).toBe(1550);
      expect(d.online).toBe(false);
      expect(d.identifiedBytes).toBe(2000);
      expect(d.label).toBe('D: 数据');
      expect(d.topFiles[0].path).toBe('D:\\Backup\\big.iso');

      const snapshots = listDriveSnapshots(db);
      expect(snapshots.find((item) => item.letter === 'D:')?.ready).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns live drives with zero identification before the first scan', () => {
    const { db } = tempDb();
    try {
      const fakeDrives = {
        refresh: () => [drive('C:'), drive('E:', { ready: false, freeBytes: 0 })],
      } as unknown as DrivesService;
      const service = new OverviewService({ db, drives: fakeDrives, now: () => 1000 });
      const overview = service.get();
      expect(overview.scan).toBeNull();
      expect(overview.totalFiles).toBe(0);
      expect(overview.drives.map((item) => item.drive)).toEqual(['C:', 'E:']);
      expect(overview.drives[0].unidentifiedBytes).toBe(6000);
      expect(overview.drives[1].online).toBe(false);
    } finally {
      db.close();
    }
  });
});
