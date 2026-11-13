import type { DatabaseSync } from 'node:sqlite';
import type { FileQuery, FileRecord, FileTypeKey, PagedResult } from '@shared/types';
import { isFileTypeKey } from '@shared/fileTypes';
import { normalizePathKey } from '../services/filesystem';

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
  if (query.rootDir) {
    conditions.push('root_dir = ? COLLATE NOCASE');
    params.push(query.rootDir);
  }
  if (query.dirPath) {
    conditions.push('dir_key = ?');
    params.push(normalizePathKey(query.dirPath));
  }
  const search = query.search?.trim().toLowerCase() ?? '';
  if (search) {
    conditions.push('(instr(name_key, ?) > 0 OR instr(path_key, ?) > 0)');
    params.push(search, search);
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

export function queryFileIds(
  db: DatabaseSync,
  scanId: number,
  query: FileQuery,
): number[] {
  const where = buildWhere(scanId, query);
  const rows = db
    .prepare(`SELECT id FROM files WHERE ${where.sql}`)
    .all(...where.params) as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

export function getFileById(
  db: DatabaseSync,
  scanId: number,
  fileId: number,
): FileRecord | null {
  const row = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE scan_id = ? AND id = ?`,
    )
    .get(scanId, fileId) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
}
