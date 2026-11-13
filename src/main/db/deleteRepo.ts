import type { DatabaseSync } from 'node:sqlite';
import { listAffectedGroupIds, reconcileDuplicateRunAfterDelete } from './duplicatesRepo';

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

export function countAllDeletedGroups(
  db: DatabaseSync,
  runId: number | null,
  requestedIds: number[],
): number {
  if (runId === null || requestedIds.length === 0) return 0;
  const requested = new Set(requestedIds);
  const rows = db
    .prepare(
      `SELECT m.group_id, m.file_id
       FROM duplicate_members m
       WHERE m.group_id IN (SELECT id FROM duplicate_groups WHERE run_id = ?)`,
    )
    .all(runId) as Array<{ group_id: number; file_id: number }>;
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    const list = grouped.get(row.group_id);
    if (list) list.push(row.file_id);
    else grouped.set(row.group_id, [row.file_id]);
  }
  let count = 0;
  for (const fileIds of grouped.values()) {
    if (fileIds.length > 0 && fileIds.every((id) => requested.has(id))) count += 1;
  }
  return count;
}

export function applyDeletedFileRows(
  db: DatabaseSync,
  scanId: number,
  runId: number | null,
  deleted: DeleteFileRow[],
): void {
  if (deleted.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = deleted.map((row) => row.id);
    const groupIds = runId === null ? [] : listAffectedGroupIds(db, runId, ids);

    for (const chunk of chunked(ids)) {
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(`DELETE FROM files WHERE scan_id = ? AND id IN (${placeholders})`).run(
        scanId,
        ...chunk,
      );
    }
    for (const chunk of chunked(deleted.map((row) => row.path_key))) {
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(`DELETE FROM hash_cache WHERE path_key IN (${placeholders})`).run(...chunk);
    }

    const removedBytes = deleted.reduce((sum, row) => sum + Math.max(0, row.size), 0);
    db.prepare(
      `UPDATE scans
       SET identified_bytes = MAX(0, identified_bytes - ?),
           total_files = MAX(0, total_files - ?)
       WHERE id = ?`,
    ).run(removedBytes, deleted.length, scanId);

    if (runId !== null) reconcileDuplicateRunAfterDelete(db, runId, groupIds);
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
