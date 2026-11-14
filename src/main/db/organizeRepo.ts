import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  getDirectoryPath,
  getDriveLetter,
  getRootDir,
  normalizePathKey,
} from '../services/filesystem';

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
    db.prepare(
      "UPDATE duplicate_runs SET status = 'stale', total_groups = 0, total_files = 0, reclaimable_bytes = 0 WHERE scan_id = ?",
    ).run(scanId);
    db.prepare(
      'DELETE FROM duplicate_groups WHERE run_id IN (SELECT id FROM duplicate_runs WHERE scan_id = ?)',
    ).run(scanId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
