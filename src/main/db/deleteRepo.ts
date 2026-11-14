import type { DatabaseSync } from 'node:sqlite';
import { normalizePathKey } from '../services/filesystem';

export interface DeleteFileRow {
  id: number;
  drive: string;
  path: string;
  path_key: string;
  name: string;
  size: number;
}

export interface FolderStats {
  bytes: number;
  count: number;
}

function chunked<T>(items: T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function listDeleteFileRows(
  db: DatabaseSync,
  scanId: number,
  fileIds: number[],
): DeleteFileRow[] {
  const rows: DeleteFileRow[] = [];
  for (const chunk of chunked(fileIds)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const found = db
      .prepare(
        `SELECT id, drive, path, path_key, name, size
         FROM files WHERE scan_id = ? AND id IN (${placeholders})`,
      )
      .all(scanId, ...chunk) as unknown as DeleteFileRow[];
    rows.push(...found);
  }
  return rows;
}

export function applyDeletedFileRows(
  db: DatabaseSync,
  scanId: number,
  deleted: DeleteFileRow[],
): void {
  if (deleted.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = deleted.map((row) => row.id);

    for (const chunk of chunked(ids)) {
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(`DELETE FROM files WHERE scan_id = ? AND id IN (${placeholders})`).run(
        scanId,
        ...chunk,
      );
    }

    const removedBytes = deleted.reduce((sum, row) => sum + Math.max(0, row.size), 0);
    db.prepare(
      `UPDATE scans
       SET identified_bytes = MAX(0, identified_bytes - ?),
           total_files = MAX(0, total_files - ?)
       WHERE id = ?`,
    ).run(removedBytes, deleted.length, scanId);

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction may already be rolled back.
    }
    throw error;
  }
}

function folderPrefix(folderPath: string): string {
  const base = normalizePathKey(folderPath);
  return base.endsWith('\\') ? base : `${base}\\`;
}

export function folderStats(db: DatabaseSync, scanId: number, folderPath: string): FolderStats {
  const prefix = folderPrefix(folderPath);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
       FROM files WHERE scan_id = ? AND substr(path_key, 1, ?) = ?`,
    )
    .get(scanId, prefix.length, prefix) as unknown as FolderStats;
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}

export function applyDeletedFolders(db: DatabaseSync, scanId: number, folders: string[]): void {
  if (folders.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const folder of folders) {
      const prefix = folderPrefix(folder);
      db.prepare('DELETE FROM files WHERE scan_id = ? AND substr(path_key, 1, ?) = ?').run(
        scanId,
        prefix.length,
        prefix,
      );
    }
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
         FROM files WHERE scan_id = ?`,
      )
      .get(scanId) as { count: number; bytes: number };
    db.prepare('UPDATE scans SET total_files = ?, identified_bytes = ? WHERE id = ?').run(
      totals.count,
      totals.bytes,
      scanId,
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction may already be rolled back.
    }
    throw error;
  }
}
