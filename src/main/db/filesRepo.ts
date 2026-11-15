import type { DatabaseSync } from 'node:sqlite';
import type {
  FileQuery,
  FileRecord,
  FileTypeKey,
  FolderContents,
  FolderFacet,
  FolderQuery,
  PagedResult,
} from '@shared/types';
import { isFileTypeKey } from '@shared/fileTypes';
import { getDriveLetter, normalizePathKey } from '../services/filesystem';

interface FileRow {
  id: number;
  drive: string;
  path: string;
  name: string;
  ext: string;
  type: string;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  root_dir: string;
  dir_path: string;
}

const TYPE_ORDER_SQL = `CASE type
  WHEN 'video' THEN 0
  WHEN 'image' THEN 1
  WHEN 'document' THEN 2
  WHEN 'audio' THEN 3
  WHEN 'archive' THEN 4
  WHEN 'installer' THEN 5
  WHEN 'diskImage' THEN 6
  WHEN 'program' THEN 7
  ELSE 8
END`;

const SORT_SQL: Record<FileQuery['sortBy'], string> = {
  size: 'size',
  mtime: 'mtime_ms',
  name: 'name_key',
  type: TYPE_ORDER_SQL,
};

export function mapFileRow(row: FileRow): FileRecord {
  return {
    id: row.id,
    drive: row.drive,
    path: row.path,
    name: row.name,
    ext: row.ext,
    type: isFileTypeKey(row.type) ? (row.type as FileTypeKey) : 'other',
    size: row.size,
    mtimeMs: row.mtime_ms,
    ctimeMs: row.ctime_ms,
    rootDir: row.root_dir,
    dirPath: row.dir_path,
  };
}

interface WhereClause {
  sql: string;
  params: Array<string | number>;
}

function pushValueFilters(
  query: Pick<FolderQuery, 'minSize' | 'maxSize' | 'mtimeFrom' | 'mtimeTo' | 'search'>,
  conditions: string[],
  params: Array<string | number>,
): void {
  if (typeof query.minSize === 'number' && Number.isFinite(query.minSize)) {
    conditions.push('size >= ?');
    params.push(Math.max(0, query.minSize));
  }
  if (typeof query.maxSize === 'number' && Number.isFinite(query.maxSize)) {
    conditions.push('size <= ?');
    params.push(Math.max(0, query.maxSize));
  }
  if (typeof query.mtimeFrom === 'number' && Number.isFinite(query.mtimeFrom)) {
    conditions.push('mtime_ms >= ?');
    params.push(query.mtimeFrom);
  }
  if (typeof query.mtimeTo === 'number' && Number.isFinite(query.mtimeTo)) {
    conditions.push('mtime_ms <= ?');
    params.push(query.mtimeTo);
  }
  const search = query.search?.trim().toLowerCase() ?? '';
  if (search) {
    conditions.push('(instr(name_key, ?) > 0 OR instr(path_key, ?) > 0)');
    params.push(search, search);
  }
}

function buildWhere(scanId: number, query: FileQuery): WhereClause {
  const conditions = ['scan_id = ?'];
  const params: Array<string | number> = [scanId];

  if (query.drive) {
    conditions.push('drive = ?');
    params.push(query.drive);
  }
  if (query.type && query.type !== 'all') {
    conditions.push('type = ?');
    params.push(query.type);
  }
  pushValueFilters(query, conditions, params);
  if (query.rootDir) {
    conditions.push('root_dir = ? COLLATE NOCASE');
    params.push(query.rootDir);
  }
  if (query.dirPath) {
    conditions.push('dir_key = ?');
    params.push(normalizePathKey(query.dirPath));
  }
  if (query.dirPrefix) {
    const base = normalizePathKey(query.dirPrefix);
    const prefix = base.endsWith('\\') ? base : `${base}\\`;
    conditions.push('substr(path_key, 1, ?) = ?');
    params.push(prefix.length, prefix);
  }

  return { sql: conditions.join(' AND '), params };
}

function clampPage(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(value)));
}

export function queryFiles(
  db: DatabaseSync,
  scanId: number,
  query: FileQuery,
): PagedResult<FileRecord> {
  const page = clampPage(query.page);
  const pageSize = clampPageSize(query.pageSize);
  const where = buildWhere(scanId, query);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE ${where.sql}`,
    )
    .get(...where.params) as { count: number; bytes: number };

  const sortExpression = SORT_SQL[query.sortBy] ?? SORT_SQL.size;
  const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortExpression} ${direction}, size DESC, path_key ASC`;
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE ${where.sql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, pageSize, offset) as unknown as FileRow[];

  return {
    items: rows.map(mapFileRow),
    total: totals.count,
    totalBytes: totals.bytes,
    page,
    pageSize,
  };
}

export function queryFileIds(db: DatabaseSync, scanId: number, query: FileQuery): number[] {
  const where = buildWhere(scanId, query);
  const rows = db
    .prepare(`SELECT id FROM files WHERE ${where.sql}`)
    .all(...where.params) as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function firstLevelFolderPath(drive: string, name: string, sample: string): string {
  const marker = `\\${name.toLowerCase()}\\`;
  const index = sample.toLowerCase().indexOf(marker);
  if (index >= 0) return sample.slice(0, index + 1 + name.length);
  return `${drive}\\${name}`;
}

export function listFolders(db: DatabaseSync, scanId: number, query: FolderQuery): FolderFacet[] {
  const conditions = ['scan_id = ?'];
  const params: Array<string | number> = [scanId];
  if (query.drive) {
    conditions.push('drive = ?');
    params.push(query.drive);
  }
  pushValueFilters(query, conditions, params);

  if (!query.parentDir) {
    conditions.push("root_dir <> ''");
    const rows = db
      .prepare(
        `SELECT drive, root_dir AS name, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count,
                MIN(path) AS sample
         FROM files
         WHERE ${conditions.join(' AND ')}
         GROUP BY drive, root_dir
         ORDER BY bytes DESC, drive ASC, name ASC`,
      )
      .all(...params) as Array<{
      drive: string;
      name: string;
      bytes: number;
      count: number;
      sample: string;
    }>;
    return rows.map((row) => ({
      drive: row.drive,
      path: firstLevelFolderPath(row.drive, row.name, row.sample),
      name: row.name,
      bytes: row.bytes,
      count: row.count,
    }));
  }

  const parentKey = normalizePathKey(query.parentDir);
  const baseKey = parentKey.endsWith('\\') ? parentKey.slice(0, -1) : parentKey;
  const prefix = `${baseKey}\\`;
  const start = baseKey.length + 2;
  const rows = db
    .prepare(
      `SELECT MIN(name) AS name, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       FROM (
         SELECT substr(path, ?, instr(substr(path, ?), char(92)) - 1) AS name, size
         FROM files
         WHERE ${conditions.join(' AND ')}
           AND substr(path_key, 1, ?) = ?
           AND instr(substr(path_key, ?), char(92)) > 0
       )
       GROUP BY lower(name)
       ORDER BY bytes DESC, name ASC`,
    )
    .all(start, start, ...params, prefix.length, prefix, start) as Array<{
    name: string;
    bytes: number;
    count: number;
  }>;
  const drive = getDriveLetter(query.parentDir);
  const parentPrefix = query.parentDir.replace(/\\+$/, '');
  return rows.map((row) => ({
    drive,
    path: `${parentPrefix}\\${row.name}`,
    name: row.name,
    bytes: row.bytes,
    count: row.count,
  }));
}

export function listFolderContents(
  db: DatabaseSync,
  scanId: number,
  query: FolderQuery,
  limit = 200,
): FolderContents {
  if (!query.parentDir) return { folders: [], files: [], totalFiles: 0 };
  const folders = listFolders(db, scanId, query);
  const conditions = ['scan_id = ?', 'dir_key = ?'];
  const params: Array<string | number> = [scanId, normalizePathKey(query.parentDir)];
  pushValueFilters(query, conditions, params);
  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM files WHERE ${where}`).get(...params) as {
    count: number;
  };
  const rows = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE ${where}
       ORDER BY name_key ASC
       LIMIT ?`,
    )
    .all(...params, Math.min(200, Math.max(1, limit))) as unknown as FileRow[];
  return { folders, files: rows.map(mapFileRow), totalFiles: total.count };
}

export function listSourceFileIds(
  db: DatabaseSync,
  scanId: number,
  prefix: string,
  afterId = 0,
  limit = 2000,
): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM files
       WHERE scan_id = ? AND substr(path_key, 1, ?) = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(scanId, prefix.length, prefix, afterId, limit) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

export function listSourceFolderDirs(
  db: DatabaseSync,
  scanId: number,
  prefix: string,
  afterKey = '',
  limit = 2000,
): Array<{ path: string; key: string }> {
  const rows = db
    .prepare(
      `SELECT MIN(dir_path) AS path, dir_key AS key FROM files
       WHERE scan_id = ? AND substr(path_key, 1, ?) = ? AND dir_key > ?
       GROUP BY dir_key
       ORDER BY dir_key
       LIMIT ?`,
    )
    .all(scanId, prefix.length, prefix, afterKey, limit) as Array<{ path: string; key: string }>;
  return rows;
}

export function getFilesByIds(db: DatabaseSync, scanId: number, ids: number[]): FileRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE scan_id = ? AND id IN (${placeholders})
       ORDER BY id`,
    )
    .all(scanId, ...ids) as unknown as FileRow[];
  return rows.map(mapFileRow);
}

export function getFileById(db: DatabaseSync, scanId: number, fileId: number): FileRecord | null {
  const row = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE scan_id = ? AND id = ?`,
    )
    .get(scanId, fileId) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
}

export interface IndexFileRef {
  id: number;
  path: string;
  pathKey: string;
  size: number;
  drive: string;
}

const SYNC_CHUNK_SIZE = 500;

export function listIndexFileRefs(
  db: DatabaseSync,
  scanId: number,
  afterId = 0,
  limit = 2000,
): IndexFileRef[] {
  const rows = db
    .prepare(
      `SELECT id, path, path_key, size, drive FROM files
       WHERE scan_id = ? AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(scanId, afterId, limit) as unknown as Array<{
    id: number;
    path: string;
    path_key: string;
    size: number;
    drive: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    pathKey: row.path_key,
    size: row.size,
    drive: row.drive,
  }));
}

export function pruneMissingFiles(db: DatabaseSync, scanId: number, missing: IndexFileRef[]): void {
  if (missing.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < missing.length; index += SYNC_CHUNK_SIZE) {
      const chunk = missing.slice(index, index + SYNC_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(`DELETE FROM files WHERE scan_id = ? AND id IN (${placeholders})`).run(
        scanId,
        ...chunk.map((row) => row.id),
      );
      db.prepare(`DELETE FROM hash_cache WHERE path_key IN (${placeholders})`).run(
        ...chunk.map((row) => row.pathKey),
      );
    }
    const removedBytes = missing.reduce((sum, row) => sum + Math.max(0, row.size), 0);
    db.prepare(
      `UPDATE scans
       SET identified_bytes = MAX(0, identified_bytes - ?),
           total_files = MAX(0, total_files - ?)
       WHERE id = ?`,
    ).run(removedBytes, missing.length, scanId);
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
