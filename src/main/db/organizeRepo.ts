import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  getDirectoryPath,
  getDriveLetter,
  getRootDir,
  normalizePathKey,
} from '../services/filesystem';

function invalidateDuplicateResults(db: DatabaseSync, scanId: number): void {
  db.prepare(
    "UPDATE duplicate_runs SET status = 'stale', total_groups = 0, total_files = 0, reclaimable_bytes = 0 WHERE scan_id = ?",
  ).run(scanId);
  db.prepare(
    'DELETE FROM duplicate_groups WHERE run_id IN (SELECT id FROM duplicate_runs WHERE scan_id = ?)',
  ).run(scanId);
}

export function updateOrganizedFolder(
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
    const moved = db
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
    invalidateDuplicateResults(db, scanId);
    db.exec('COMMIT');
    return Number(moved.changes);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function updateOrganizedFile(
  db: DatabaseSync,
  scanId: number,
  fileId: number,
  source: string,
  target: string,
): void {
  const stat = fs.statSync(target, { bigint: true });
  const drive = getDriveLetter(target);
  const dir = getDirectoryPath(target);
  const name = path.basename(target);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        `UPDATE files SET drive = ?, path = ?, path_key = ?, name = ?, name_key = ?,
      mtime_ms = ?, ctime_ms = ?, root_dir = ?, dir_path = ?, dir_key = ?, volume_id = ?, file_id = ?
      WHERE scan_id = ? AND id = ? AND path_key = ?`,
      )
      .run(
        drive,
        target,
        normalizePathKey(target),
        name,
        name.toLowerCase(),
        Number(stat.mtimeMs),
        Number(stat.ctimeMs),
        getRootDir(target, `${drive}\\`),
        dir,
        normalizePathKey(dir),
        stat.dev.toString(16),
        stat.ino.toString(16),
        scanId,
        fileId,
        normalizePathKey(source),
      );
    if (Number(result.changes) !== 1) throw new Error('文件索引已变化');
    db.prepare('DELETE FROM hash_cache WHERE path_key IN (?, ?)').run(
      normalizePathKey(source),
      normalizePathKey(target),
    );
    invalidateDuplicateResults(db, scanId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
