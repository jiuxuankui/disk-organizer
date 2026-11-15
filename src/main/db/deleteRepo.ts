import type { DatabaseSync } from 'node:sqlite';
import { normalizePathKey } from '../services/filesystem';
import { listAffectedGroupIds, reconcileDuplicateRunAfterDelete } from './duplicatesRepo';

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

export function countAllDeletedGroups(
  db: DatabaseSync,
  runId: number | null,
  requestedIds: number[],
  folderPaths: string[] = [],
): number {
  if (runId === null) return 0;
  if (requestedIds.length === 0 && folderPaths.length === 0) return 0;
  const requested = new Set(requestedIds);
  const prefixes = folderPaths.map(folderPrefix);
  const rows = db
    .prepare(
      `SELECT m.group_id, m.file_id, m.path
       FROM duplicate_members m
       WHERE m.group_id IN (SELECT id FROM duplicate_groups WHERE run_id = ?)`,
    )
    .all(runId) as Array<{ group_id: number; file_id: number; path: string }>;
  const grouped = new Map<number, boolean[]>();
  for (const row of rows) {
    const pathKey = normalizePathKey(row.path);
    const covered =
      requested.has(row.file_id) || prefixes.some((prefix) => pathKey.startsWith(prefix));
    const list = grouped.get(row.group_id);
    if (list) list.push(covered);
    else grouped.set(row.group_id, [covered]);
  }
  let count = 0;
  for (const covered of grouped.values()) {
    if (covered.length > 0 && covered.every(Boolean)) count += 1;
  }
  return count;
}

export function applyDeletedFileRows(
  db: DatabaseSync,
  scanId: number,
  deleted: DeleteFileRow[],
  runId: number | null = null,
): void {
  if (deleted.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = deleted.map((row) => row.id);
    const groupIds = runId === null ? [] : listAffectedGroupIds(db, runId, ids);
    const pathKeys = deleted.map((row) => row.path_key);

    for (const chunk of chunked(ids)) {
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(`DELETE FROM files WHERE scan_id = ? AND id IN (${placeholders})`).run(
        scanId,
        ...chunk,
      );
    }
    for (const chunk of chunked(pathKeys)) {
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

export function applyDeletedFolders(
  db: DatabaseSync,
  scanId: number,
  folders: string[],
  runId: number | null = null,
): void {
  if (folders.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const affected = new Set<number>();
    for (const folder of folders) {
      const prefix = folderPrefix(folder);
      if (runId !== null) {
        const rows = db
          .prepare(
            `SELECT id FROM files WHERE scan_id = ? AND substr(path_key, 1, ?) = ?`,
          )
          .all(scanId, prefix.length, prefix) as Array<{ id: number }>;
        for (const groupId of listAffectedGroupIds(
          db,
          runId,
          rows.map((row) => row.id),
        )) {
          affected.add(groupId);
        }
      }
      db.prepare('DELETE FROM files WHERE scan_id = ? AND substr(path_key, 1, ?) = ?').run(
        scanId,
        prefix.length,
        prefix,
      );
      db.prepare('DELETE FROM hash_cache WHERE path_key LIKE ?').run(`${prefix}%`);
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
    if (runId !== null) reconcileDuplicateRunAfterDelete(db, runId, [...affected]);
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
