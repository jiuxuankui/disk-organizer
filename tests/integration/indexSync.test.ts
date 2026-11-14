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
  getActiveScanSummary,
  setActiveScanId,
} from '../../src/main/db/scansRepo';
import { normalizePathKey } from '../../src/main/services/filesystem';
import { IndexSyncService } from '../../src/main/services/indexSyncService';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-sync-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

interface SeededFile {
  path: string;
  pathKey: string;
  size: number;
  mtimeMs: number;
}

function createFile(root: string, relative: string, content: Buffer): SeededFile {
  const fullPath = path.join(root, relative);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  const stats = fs.statSync(fullPath, { bigint: true });
  return {
    path: fullPath,
    pathKey: normalizePathKey(fullPath),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

function insertFile(db: DatabaseSync, scanId: number, file: SeededFile, drive = 'C:'): number {
  const name = path.win32.basename(file.path);
  const dirPath = path.win32.dirname(file.path);
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
      file.pathKey,
      name,
      name.toLowerCase(),
      getExtension(name),
      classifyFileName(name),
      file.size,
      file.mtimeMs,
      file.mtimeMs,
      path.win32.basename(dirPath),
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
  files: [SeededFile, SeededFile];
  ids: [number, number];
}

function seed(): Seed {
  const temp = createTempDbPath('disk-organizer-sync-db-');
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
  const first = createFile(root, 'docs\\first.txt', Buffer.alloc(1024, 0x31));
  const second = createFile(root, 'docs\\second.txt', Buffer.alloc(2048, 0x32));
  const scanId = createScan(db, ['C:'], 1000);
  const idA = insertFile(db, scanId, first);
  const idB = insertFile(db, scanId, second);
  finalizeScan(db, scanId, {
    totalFiles: 2,
    identifiedBytes: first.size + second.size,
    skipped: [],
    finishedAt: 2000,
  });
  setActiveScanId(db, scanId);
  return { db, scanId, root, files: [first, second], ids: [idA, idB] };
}

function countFiles(db: DatabaseSync, scanId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM files WHERE scan_id = ?').get(scanId) as {
    count: number;
  };
  return row.count;
}

function readyDrives(letter = 'C:', ready = true) {
  return { refresh: () => [{ letter, ready }] };
}

describe('IndexSyncService', () => {
  it('移除磁盘上已不存在的文件并同步扫描统计', async () => {
    const { db, scanId, files, ids } = seed();
    fs.rmSync(files[0].path);
    const service = new IndexSyncService({ db, drives: readyDrives() });
    const result = await service.sync();

    expect(result).toEqual({ removed: 1, checked: 2, skipped: false });
    expect(countFiles(db, scanId)).toBe(1);
    const summary = getActiveScanSummary(db);
    expect(summary?.totalFiles).toBe(1);
    expect(summary?.identifiedBytes).toBe(files[1].size);
    expect(db.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?').get(ids[0])).toEqual({
      count: 0,
    });

    const again = await service.sync();
    expect(again).toEqual({ removed: 0, checked: 1, skipped: false });
  });

  it('硬盘未就绪时不判断文件缺失', async () => {
    const { db, scanId, files } = seed();
    fs.rmSync(files[0].path);
    const service = new IndexSyncService({
      db,
      drives: readyDrives('C:', false),
    });
    const result = await service.sync();

    expect(result).toEqual({ removed: 0, checked: 0, skipped: false });
    expect(countFiles(db, scanId)).toBe(2);
  });

  it('扫描、删除或整理进行中时跳过同步', async () => {
    const { db, scanId, files } = seed();
    fs.rmSync(files[0].path);
    const service = new IndexSyncService({
      db,
      drives: readyDrives(),
      isBusy: () => true,
    });
    const result = await service.sync();

    expect(result).toEqual({ removed: 0, checked: 0, skipped: true });
    expect(countFiles(db, scanId)).toBe(2);
  });

  it('尚未扫描时直接跳过', async () => {
    const temp = createTempDbPath('disk-organizer-sync-empty-');
    cleanups.push(temp.cleanup);
    const db = openDatabase(temp.dbPath);
    cleanups.push(() => db.close());
    const service = new IndexSyncService({ db, drives: readyDrives() });

    await expect(service.sync()).resolves.toEqual({ removed: 0, checked: 0, skipped: true });
  });
});
