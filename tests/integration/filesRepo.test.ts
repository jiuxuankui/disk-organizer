import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { FileQuery, FileTypeKey } from '@shared/types';
import { openDatabase } from '../../src/main/db/connection';
import { createScan, finalizeScan, setActiveScanId } from '../../src/main/db/scansRepo';
import { getFileById, listFolders, queryFileIds, queryFiles } from '../../src/main/db/filesRepo';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDb(): DatabaseSync {
  const temp = createTempDbPath();
  cleanups.push(temp.cleanup);
  return openDatabase(temp.dbPath);
}

function insertFile(
  db: DatabaseSync,
  scanId: number,
  path: string,
  size: number,
  type: FileTypeKey,
  mtimeMs: number,
): void {
  const drive = path.slice(0, 2).toUpperCase();
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
    drive,
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

function seed(db: DatabaseSync): number {
  const scanId = createScan(db, ['C:', 'D:'], 1000);
  insertFile(db, scanId, 'C:\\Movies\\a.mkv', 500, 'video', 10);
  insertFile(db, scanId, 'C:\\Movies\\b.mp4', 300, 'video', 20);
  insertFile(db, scanId, 'C:\\Movies\\Sub\\s.mkv', 400, 'video', 25);
  insertFile(db, scanId, 'C:\\Pics\\z.jpg', 500, 'image', 30);
  insertFile(db, scanId, 'C:\\Pics\\y.jpg', 100, 'image', 40);
  insertFile(db, scanId, 'C:\\Docs\\c.pdf', 100, 'document', 50);
  insertFile(db, scanId, 'C:\\root.txt', 50, 'document', 60);
  insertFile(db, scanId, 'D:\\Backup\\big.iso', 2000, 'diskImage', 70);
  finalizeScan(db, scanId, {
    totalFiles: 8,
    identifiedBytes: 3950,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);
  return scanId;
}

function baseQuery(patch: Partial<FileQuery> = {}): FileQuery {
  return {
    drive: null,
    type: null,
    minSize: null,
    maxSize: null,
    mtimeFrom: null,
    mtimeTo: null,
    rootDir: null,
    dirPath: null,
    dirPrefix: null,
    search: '',
    sortBy: 'size',
    sortOrder: 'desc',
    page: 1,
    pageSize: 200,
    ...patch,
  };
}

describe('files repository', () => {
  it('returns all drives merged by size with totals', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      const result = queryFiles(db, scanId, baseQuery());
      expect(result.total).toBe(8);
      expect(result.totalBytes).toBe(3950);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(200);
      expect(result.items.map((item) => item.name)).toEqual([
        'big.iso',
        'a.mkv',
        'z.jpg',
        's.mkv',
        'b.mp4',
        'c.pdf',
        'y.jpg',
        'root.txt',
      ]);
      expect(result.items[0].type).toBe('diskImage');
    } finally {
      db.close();
    }
  });

  it('applies each filter and combined filters', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      expect(queryFiles(db, scanId, baseQuery({ drive: 'C:' }))).toMatchObject({
        total: 7,
        totalBytes: 1950,
      });
      expect(queryFiles(db, scanId, baseQuery({ type: 'video' }))).toMatchObject({
        total: 3,
        totalBytes: 1200,
      });
      expect(queryFiles(db, scanId, baseQuery({ minSize: 400, maxSize: 500 }))).toMatchObject({
        total: 3,
        totalBytes: 1400,
      });
      expect(queryFiles(db, scanId, baseQuery({ mtimeFrom: 25, mtimeTo: 50 }))).toMatchObject({
        total: 4,
      });
      expect(queryFiles(db, scanId, baseQuery({ rootDir: 'movies' }))).toMatchObject({
        total: 3,
        totalBytes: 1200,
      });
      expect(queryFiles(db, scanId, baseQuery({ dirPath: 'C:\\Movies\\Sub' }))).toMatchObject({
        total: 1,
        totalBytes: 400,
      });
      expect(
        queryFiles(db, scanId, baseQuery({ drive: 'C:', type: 'video', minSize: 350 })),
      ).toMatchObject({ total: 2, totalBytes: 900 });
    } finally {
      db.close();
    }
  });

  it('lists root folders with counts and sizes, optionally scoped to one drive', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      const all = listFolders(db, scanId, { parentDir: null, drive: null });
      expect(all).toEqual([
        { drive: 'D:', path: 'D:\\Backup', name: 'Backup', bytes: 2000, count: 1 },
        { drive: 'C:', path: 'C:\\Movies', name: 'Movies', bytes: 1200, count: 3 },
        { drive: 'C:', path: 'C:\\Pics', name: 'Pics', bytes: 600, count: 2 },
        { drive: 'C:', path: 'C:\\Docs', name: 'Docs', bytes: 100, count: 1 },
      ]);
      expect(
        listFolders(db, scanId, { parentDir: null, drive: 'C:' }).map((folder) => folder.name),
      ).toEqual(['Movies', 'Pics', 'Docs']);
      expect(listFolders(db, createScan(db, ['C:'], 4000), { parentDir: null })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('lists direct subfolders recursively with filtered totals', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Movies' })).toEqual([
        { drive: 'C:', path: 'C:\\Movies\\Sub', name: 'Sub', bytes: 400, count: 1 },
      ]);
      expect(listFolders(db, scanId, { parentDir: 'c:\\movies\\sub' })).toEqual([]);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Pics' })).toEqual([]);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Movies', minSize: 450 })).toEqual([]);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Movies', minSize: 300 })).toHaveLength(1);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Movies', search: 's.mkv' })).toHaveLength(1);
      expect(listFolders(db, scanId, { parentDir: 'C:\\Movies', search: 'a.mkv' })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('filters files recursively with dirPrefix while dirPath stays exact', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      expect(queryFiles(db, scanId, baseQuery({ dirPath: 'C:\\Movies' }))).toMatchObject({
        total: 2,
        totalBytes: 800,
      });
      expect(queryFiles(db, scanId, baseQuery({ dirPrefix: 'C:\\Movies' }))).toMatchObject({
        total: 3,
        totalBytes: 1200,
      });
      expect(queryFiles(db, scanId, baseQuery({ dirPrefix: 'c:\\movies' }))).toMatchObject({
        total: 3,
      });
      expect(
        queryFiles(db, scanId, baseQuery({ dirPrefix: 'C:\\Movies', type: 'video' })),
      ).toMatchObject({ total: 3 });
      expect(
        queryFiles(db, scanId, baseQuery({ dirPrefix: 'C:\\Movies', search: 'sub' })),
      ).toMatchObject({ total: 1 });
      expect(queryFiles(db, scanId, baseQuery({ dirPrefix: 'C:\\Missing' }))).toMatchObject({
        total: 0,
      });
    } finally {
      db.close();
    }
  });

  it('searches names and paths case-insensitively and treats wildcards literally', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      expect(
        queryFiles(db, scanId, baseQuery({ search: 'Z.JPG' })).items.map((f) => f.name),
      ).toEqual(['z.jpg']);
      expect(queryFiles(db, scanId, baseQuery({ search: 'backup' }))).toMatchObject({
        total: 1,
        totalBytes: 2000,
      });
      expect(queryFiles(db, scanId, baseQuery({ search: 'MOVIES' }))).toMatchObject({
        total: 3,
      });
      expect(queryFiles(db, scanId, baseQuery({ search: '%' })).total).toBe(0);
      expect(queryFiles(db, scanId, baseQuery({ search: 'sub', type: 'video' }))).toMatchObject({
        total: 1,
      });
    } finally {
      db.close();
    }
  });

  it('sorts by name, time and type in both directions', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'name', sortOrder: 'asc' }))
          .items.slice(0, 3)
          .map((f) => f.name),
      ).toEqual(['a.mkv', 'b.mp4', 'big.iso']);
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'name', sortOrder: 'desc' })).items[0].name,
      ).toBe('z.jpg');
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'mtime', sortOrder: 'asc' })).items[0].name,
      ).toBe('a.mkv');
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'mtime', sortOrder: 'desc' })).items[0].name,
      ).toBe('big.iso');
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'type', sortOrder: 'asc' })).items[0].name,
      ).toBe('a.mkv');
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'type', sortOrder: 'desc' })).items[0].name,
      ).toBe('big.iso');
      expect(
        queryFiles(db, scanId, baseQuery({ sortBy: 'size', sortOrder: 'asc' })).items[0].name,
      ).toBe('root.txt');
    } finally {
      db.close();
    }
  });

  it('pages results while keeping filter totals intact', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      const page = queryFiles(db, scanId, baseQuery({ page: 2, pageSize: 3 }));
      expect(page.total).toBe(8);
      expect(page.totalBytes).toBe(3950);
      expect(page.items.map((item) => item.name)).toEqual(['s.mkv', 'b.mp4', 'c.pdf']);
      const beyond = queryFiles(db, scanId, baseQuery({ page: 99, pageSize: 3 }));
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(8);
    } finally {
      db.close();
    }
  });

  it('lists ids for every filtered result regardless of paging', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      const all = queryFileIds(db, scanId, baseQuery());
      expect(all).toHaveLength(8);
      expect(new Set(all).size).toBe(8);
      const videos = queryFileIds(db, scanId, baseQuery({ type: 'video', page: 3, pageSize: 1 }));
      expect(videos).toHaveLength(3);
      const names = queryFiles(db, scanId, baseQuery({ type: 'video' })).items.map(
        (item) => item.id,
      );
      expect(videos.sort()).toEqual(names.sort());
      expect(queryFileIds(db, scanId, baseQuery({ search: 'nothing-matches' }))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('reads a single file only from the requested scan', () => {
    const db = tempDb();
    try {
      const scanId = seed(db);
      const first = queryFiles(db, scanId, baseQuery({ pageSize: 1 })).items[0];
      expect(getFileById(db, scanId, first.id)).toEqual(first);
      expect(getFileById(db, scanId, 999999)).toBeNull();
      const otherScan = createScan(db, ['C:'], 3000);
      expect(getFileById(db, otherScan, first.id)).toBeNull();
    } finally {
      db.close();
    }
  });
});
