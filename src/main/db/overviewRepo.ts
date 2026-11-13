import type { DatabaseSync } from 'node:sqlite';
import type {
  DriveOverview,
  DriveInfo,
  FileRecord,
  FileTypeKey,
  FolderUsage,
  TypeUsage,
} from '@shared/types';
import { FILE_TYPES, isFileTypeKey } from '@shared/fileTypes';
import { TOP_LIST_COUNT } from '@shared/constants';

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

interface TypeRow {
  type: string;
  bytes: number;
  count: number;
}

interface FolderRow {
  root_dir: string;
  bytes: number;
  count: number;
}

function mapFileRow(row: FileRow): FileRecord {
  return {
    id: row.id,
    drive: row.drive,
    path: row.path,
    name: row.name,
    ext: row.ext,
    type: isFileTypeKey(row.type) ? row.type : 'other',
    size: row.size,
    mtimeMs: row.mtime_ms,
    ctimeMs: row.ctime_ms,
    rootDir: row.root_dir,
    dirPath: row.dir_path,
  };
}

export function listTopFiles(
  db: DatabaseSync,
  scanId: number,
  drive: string,
  limit = TOP_LIST_COUNT,
): FileRecord[] {
  const rows = db
    .prepare(
      `SELECT id, drive, path, name, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path
       FROM files
       WHERE scan_id = ? AND drive = ?
       ORDER BY size DESC, path ASC
       LIMIT ?`,
    )
    .all(scanId, drive, limit) as unknown as FileRow[];
  return rows.map(mapFileRow);
}

export interface DriveUsageAggregate {
  typeUsage: TypeUsage[];
  count: number;
  bytes: number;
}

export function aggregateDriveUsage(
  db: DatabaseSync,
  scanId: number,
  drive: string,
): DriveUsageAggregate {
  const rows = db
    .prepare(
      `SELECT type, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
       FROM files
       WHERE scan_id = ? AND drive = ?
       GROUP BY type`,
    )
    .all(scanId, drive) as unknown as TypeRow[];
  const byType = new Map<FileTypeKey, TypeUsage>();
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    const type: FileTypeKey = isFileTypeKey(row.type) ? row.type : 'other';
    const current = byType.get(type) ?? { type, bytes: 0, count: 0 };
    current.bytes += row.bytes;
    current.count += row.count;
    byType.set(type, current);
    count += row.count;
    bytes += row.bytes;
  }
  return {
    typeUsage: FILE_TYPES.map(
      (meta) => byType.get(meta.key) ?? { type: meta.key, bytes: 0, count: 0 },
    ),
    count,
    bytes,
  };
}

export function listTypeUsage(db: DatabaseSync, scanId: number, drive: string): TypeUsage[] {
  return aggregateDriveUsage(db, scanId, drive).typeUsage;
}

export function listTopFolders(
  db: DatabaseSync,
  scanId: number,
  drive: string,
  limit = TOP_LIST_COUNT,
): FolderUsage[] {
  const rows = db
    .prepare(
      `SELECT root_dir, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
       FROM files
       WHERE scan_id = ? AND drive = ? AND root_dir <> ''
       GROUP BY root_dir
       ORDER BY bytes DESC, root_dir ASC
       LIMIT ?`,
    )
    .all(scanId, drive, limit) as unknown as FolderRow[];
  return rows.map((row) => ({
    path: `${drive}\\${row.root_dir}`,
    name: row.root_dir,
    bytes: row.bytes,
    count: row.count,
  }));
}

export function buildDriveOverview(
  db: DatabaseSync,
  scanId: number | null,
  info: DriveInfo,
): DriveOverview {
  const usedBytes = Math.max(0, info.totalBytes - info.freeBytes);
  if (scanId === null) {
    return {
      drive: info.letter,
      label: info.label,
      fileSystem: info.fileSystem,
      online: info.ready,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      identifiedBytes: 0,
      unidentifiedBytes: usedBytes,
      fileCount: 0,
      typeUsage: FILE_TYPES.map((meta) => ({ type: meta.key, bytes: 0, count: 0 })),
      topFiles: [],
      topFolders: [],
    };
  }

  const usage = aggregateDriveUsage(db, scanId, info.letter);

  return {
    drive: info.letter,
    label: info.label,
    fileSystem: info.fileSystem,
    online: info.ready,
    totalBytes: info.totalBytes,
    freeBytes: info.freeBytes,
    identifiedBytes: usage.bytes,
    unidentifiedBytes: Math.max(0, usedBytes - usage.bytes),
    fileCount: usage.count,
    typeUsage: usage.typeUsage,
    topFiles: listTopFiles(db, scanId, info.letter),
    topFolders: listTopFolders(db, scanId, info.letter),
  };
}
