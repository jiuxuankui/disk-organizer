import type { DatabaseSync } from 'node:sqlite';

export interface HashCacheRow {
  path_key: string;
  size: number;
  mtime_ms: number;
  quick_hash: string | null;
  full_hash: string | null;
}

const CACHE_QUERY_CHUNK = 500;

export function getHashCacheRows(
  db: DatabaseSync,
  pathKeys: string[],
): Map<string, HashCacheRow> {
  const result = new Map<string, HashCacheRow>();
  if (pathKeys.length === 0) return result;
  for (let index = 0; index < pathKeys.length; index += CACHE_QUERY_CHUNK) {
    const chunk = pathKeys.slice(index, index + CACHE_QUERY_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT path_key, size, mtime_ms, quick_hash, full_hash
         FROM hash_cache WHERE path_key IN (${placeholders})`,
      )
      .all(...chunk) as unknown as HashCacheRow[];
    for (const row of rows) result.set(row.path_key, row);
  }
  return result;
}

export function upsertQuickHash(
  db: DatabaseSync,
  pathKey: string,
  size: number,
  mtimeMs: number,
  quickHash: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO hash_cache (path_key, size, mtime_ms, quick_hash, full_hash, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(path_key) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       quick_hash = excluded.quick_hash,
       full_hash = NULL,
       updated_at = excluded.updated_at`,
  ).run(pathKey, size, mtimeMs, quickHash, now);
}

export function upsertFullHash(
  db: DatabaseSync,
  pathKey: string,
  size: number,
  mtimeMs: number,
  quickHash: string,
  fullHash: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO hash_cache (path_key, size, mtime_ms, quick_hash, full_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path_key) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       quick_hash = excluded.quick_hash,
       full_hash = excluded.full_hash,
       updated_at = excluded.updated_at`,
  ).run(pathKey, size, mtimeMs, quickHash, fullHash, now);
}
