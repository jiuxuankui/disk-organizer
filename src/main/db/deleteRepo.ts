import type { DatabaseSync } from 'node:sqlite';

export interface DeleteFileRow {
  id: number;
  drive: string;
  path: string;
  path_key: string;
  name: string;
  size: number;
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
