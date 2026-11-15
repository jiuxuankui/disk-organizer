import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import {
  getDirectoryPath,
  getDriveLetter,
  getRootDir,
  normalizePathKey,
  toExtendedPath,
} from '../services/filesystem';

export interface RenameFileRow {
  id: number;
  path: string;
  pathKey: string;
}

export function findFileRowByPath(
  db: DatabaseSync,
  scanId: number,
  filePath: string,
): RenameFileRow | null {
  const row = db
    .prepare('SELECT id, path, path_key FROM files WHERE scan_id = ? AND path_key = ?')
    .get(scanId, normalizePathKey(filePath)) as
    | { id: number; path: string; path_key: string }
    | undefined;
  return row ? { id: row.id, path: row.path, pathKey: row.path_key } : null;
}

export function findFileRowById(
  db: DatabaseSync,
  scanId: number,
  fileId: number,
): RenameFileRow | null {
  const row = db
    .prepare('SELECT id, path, path_key FROM files WHERE scan_id = ? AND id = ?')
    .get(scanId, fileId) as { id: number; path: string; path_key: string } | undefined;
  return row ? { id: row.id, path: row.path, pathKey: row.path_key } : null;
}

export function syncRenamedFile(
  db: DatabaseSync,
  scanId: number,
  fileId: number | null,
  source: string,
  target: string,
): boolean {
  const sourceKey = normalizePathKey(source);
  const row =
    (fileId !== null ? findFileRowById(db, scanId, fileId) : null) ??
    findFileRowByPath(db, scanId, source);
  if (!row || row.pathKey !== sourceKey) return false;

  const stat = fs.statSync(toExtendedPath(target), { bigint: true });
  const drive = getDriveLetter(target);
  const dir = getDirectoryPath(target);
  const name = path.win32.basename(target);
  const targetKey = normalizePathKey(target);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        `UPDATE files SET drive = ?, path = ?, path_key = ?, name = ?, name_key = ?, ext = ?, type = ?,
         mtime_ms = ?, ctime_ms = ?, root_dir = ?, dir_path = ?, dir_key = ?, volume_id = ?, file_id = ?
         WHERE scan_id = ? AND id = ? AND path_key = ?`,
      )
      .run(
        drive,
        target,
        targetKey,
        name,
        name.toLowerCase(),
        getExtension(name),
        classifyFileName(name),
        Number(stat.mtimeMs),
        Number(stat.ctimeMs),
        getRootDir(target, `${drive}\\`),
        dir,
        normalizePathKey(dir),
        stat.dev.toString(16),
        stat.ino.toString(16),
        scanId,
        row.id,
        sourceKey,
      );
    if (Number(result.changes) !== 1) throw new Error('文件索引已变化');
    db.prepare('DELETE FROM hash_cache WHERE path_key IN (?, ?)').run(sourceKey, targetKey);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function syncRenamedFolder(
  db: DatabaseSync,
  scanId: number,
  source: string,
  target: string,
): number {
  const sourceKey = normalizePathKey(source).replace(/\\+$/, '');
  const targetPath = target.replace(/\\+$/, '');
  const targetKey = normalizePathKey(targetPath);
  const prefix = `${sourceKey}\\`;
  const drive = getDriveLetter(targetPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = db
      .prepare(
        `UPDATE files SET drive = ?, path = ? || substr(path, ?), path_key = ? || substr(path_key, ?),
         dir_path = ? || substr(dir_path, ?), dir_key = ? || substr(dir_key, ?)
         WHERE scan_id = ? AND substr(path_key, 1, ?) = ?`,
      )
      .run(
        drive,
        targetPath,
        sourceKey.length + 1,
        targetKey,
        sourceKey.length + 1,
        targetPath,
        sourceKey.length + 1,
        targetKey,
        sourceKey.length + 1,
        scanId,
        prefix.length,
        prefix,
      );
    const targetPrefix = `${targetKey}\\`;
    db.prepare(
      `UPDATE files SET root_dir = CASE
         WHEN instr(substr(path, 4), char(92)) > 0
         THEN substr(substr(path, 4), 1, instr(substr(path, 4), char(92)) - 1)
         ELSE '' END
       WHERE scan_id = ? AND substr(path_key, 1, ?) = ?`,
    ).run(scanId, targetPrefix.length, targetPrefix);
    db.prepare('DELETE FROM hash_cache WHERE path_key = ? OR path_key LIKE ?').run(
      sourceKey,
      `${sourceKey}\\%`,
    );
    db.exec('COMMIT');
    return Number(updated.changes);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function invalidateDuplicateResults(db: DatabaseSync, scanId: number): void {
  db.prepare(
    "UPDATE duplicate_runs SET status = 'stale', total_groups = 0, total_files = 0, reclaimable_bytes = 0 WHERE scan_id = ?",
  ).run(scanId);
  db.prepare(
    'DELETE FROM duplicate_groups WHERE run_id IN (SELECT id FROM duplicate_runs WHERE scan_id = ?)',
  ).run(scanId);
}

export function recoverRenameBatches(db: DatabaseSync): void {
  db.prepare(
    "UPDATE rename_batches SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
  ).run(Date.now());
}

export function pruneRenameBatches(db: DatabaseSync, keepBatchId: number): void {
  db.prepare('DELETE FROM rename_undo_items WHERE batch_id != ?').run(keepBatchId);
  db.prepare('DELETE FROM rename_batches WHERE id != ?').run(keepBatchId);
}

export function createRenameBatch(db: DatabaseSync, total: number): number {
  const result = db
    .prepare("INSERT INTO rename_batches (created_at, finished_at, status, total) VALUES (?, NULL, 'running', ?)")
    .run(Date.now(), total);
  return Number(result.lastInsertRowid);
}

export function appendRenameUndoItem(
  db: DatabaseSync,
  batchId: number,
  kind: 'file' | 'folder',
  source: string,
  target: string,
): void {
  db.prepare(
    "INSERT INTO rename_undo_items (batch_id, kind, source, target, status, message) VALUES (?, ?, ?, ?, 'renamed', '')",
  ).run(batchId, kind, source, target);
}

export function finishRenameBatch(
  db: DatabaseSync,
  batchId: number,
  status: 'completed' | 'cancelled' | 'interrupted' | 'undone',
): void {
  db.prepare('UPDATE rename_batches SET status = ?, finished_at = ? WHERE id = ?').run(
    status,
    Date.now(),
    batchId,
  );
}

export interface UndoBatch {
  id: number;
  createdAt: number;
  count: number;
}

export function getUndoBatch(db: DatabaseSync): UndoBatch | null {
  const row = db
    .prepare(
      `SELECT b.id AS id, b.created_at AS created_at, COUNT(i.id) AS count
       FROM rename_batches b
       JOIN rename_undo_items i ON i.batch_id = b.id AND i.status = 'renamed'
       WHERE b.status IN ('completed', 'cancelled', 'interrupted')
       GROUP BY b.id
       HAVING COUNT(i.id) > 0
       ORDER BY b.id DESC
       LIMIT 1`,
    )
    .get() as { id: number; created_at: number; count: number } | undefined;
  return row ? { id: row.id, createdAt: row.created_at, count: row.count } : null;
}

export interface RenameUndoRow {
  id: number;
  kind: 'file' | 'folder';
  source: string;
  target: string;
}

export function listUndoItems(db: DatabaseSync, batchId: number): RenameUndoRow[] {
  const rows = db
    .prepare(
      "SELECT id, kind, source, target FROM rename_undo_items WHERE batch_id = ? AND status = 'renamed' ORDER BY id DESC",
    )
    .all(batchId) as Array<{ id: number; kind: 'file' | 'folder'; source: string; target: string }>;
  return rows;
}

export function setUndoItemStatus(
  db: DatabaseSync,
  itemId: number,
  status: 'renamed' | 'restored',
  message: string,
): void {
  db.prepare('UPDATE rename_undo_items SET status = ?, message = ? WHERE id = ?').run(
    status,
    message,
    itemId,
  );
}

export function countRemainingUndo(db: DatabaseSync, batchId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM rename_undo_items WHERE batch_id = ? AND status = 'renamed'")
    .get(batchId) as { count: number };
  return row.count;
}
