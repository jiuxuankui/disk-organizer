import type { DatabaseSync } from 'node:sqlite';
import type {
  DuplicateGroup,
  DuplicateGroupPage,
  DuplicateMember,
  DuplicateQuery,
  FileTypeKey,
} from '@shared/types';
import { isFileTypeKey } from '@shared/fileTypes';

export interface DuplicateRunRecord {
  id: number;
  scanId: number;
  status: string;
  drives: string[];
  minSize: number;
  createdAt: number;
  finishedAt: number | null;
  totalGroups: number;
  totalFiles: number;
  reclaimableBytes: number;
}

interface RunRow {
  id: number;
  scan_id: number;
  status: string;
  drives_json: string;
  min_size: number;
  created_at: number;
  finished_at: number | null;
  total_groups: number;
  total_files: number;
  reclaimable_bytes: number;
}

export interface CandidateRow {
  id: number;
  drive: string;
  path: string;
  path_key: string;
  name: string;
  ext: string;
  type: string;
  size: number;
  mtime_ms: number;
  volume_id: string;
  file_id: string;
}

export interface DuplicateGroupInput {
  size: number;
  type: FileTypeKey;
  mixedExt: boolean;
  members: Array<{
    fileId: number;
    path: string;
    name: string;
    mtimeMs: number;
    suggestedKeep: boolean;
  }>;
}

function parseDrives(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function mapRun(row: RunRow): DuplicateRunRecord {
  return {
    id: row.id,
    scanId: row.scan_id,
    status: row.status,
    drives: parseDrives(row.drives_json),
    minSize: row.min_size,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    totalGroups: row.total_groups,
    totalFiles: row.total_files,
    reclaimableBytes: row.reclaimable_bytes,
  };
}

export function listDuplicateCandidates(
  db: DatabaseSync,
  scanId: number,
  minSize: number,
  drives?: string[],
): CandidateRow[] {
  const threshold = Math.max(0, Math.floor(minSize));
  if (drives !== undefined && drives.length === 0) return [];
  const driveClause =
    drives !== undefined ? ` AND drive IN (${drives.map(() => '?').join(', ')})` : '';
  const driveParams = drives ?? [];
  return db
    .prepare(
      `SELECT id, drive, path, path_key, name, ext, type, size, mtime_ms, volume_id, file_id
       FROM files
       WHERE scan_id = ? AND size > 0 AND size >= ?${driveClause}
         AND size IN (
           SELECT size FROM files
           WHERE scan_id = ? AND size > 0 AND size >= ?${driveClause}
           GROUP BY size HAVING COUNT(*) >= 2
         )
       ORDER BY size DESC, path_key ASC`,
    )
    .all(
      scanId,
      threshold,
      ...driveParams,
      scanId,
      threshold,
      ...driveParams,
    ) as unknown as CandidateRow[];
}

export function clearDuplicateRuns(db: DatabaseSync): void {
  db.prepare('DELETE FROM duplicate_runs').run();
}

export function cancelRunningDuplicateRuns(db: DatabaseSync): number {
  const result = db
    .prepare("UPDATE duplicate_runs SET status = 'cancelled', finished_at = ? WHERE status = 'running'")
    .run(Date.now());
  return Number(result.changes);
}

export function createDuplicateRun(
  db: DatabaseSync,
  scanId: number,
  minSize: number,
  now: number,
  drives: string[],
): number {
  const result = db
    .prepare(
      "INSERT INTO duplicate_runs (scan_id, status, drives_json, min_size, created_at) VALUES (?, 'running', ?, ?, ?)",
    )
    .run(scanId, JSON.stringify(drives), minSize, now);
  return Number(result.lastInsertRowid);
}

export function finalizeDuplicateRun(
  db: DatabaseSync,
  runId: number,
  data: { groups: number; files: number; reclaimableBytes: number; finishedAt: number },
): void {
  db.prepare(
    `UPDATE duplicate_runs
     SET status = 'completed', total_groups = ?, total_files = ?, reclaimable_bytes = ?, finished_at = ?
     WHERE id = ?`,
  ).run(data.groups, data.files, data.reclaimableBytes, data.finishedAt, runId);
}

export function deleteDuplicateRun(db: DatabaseSync, runId: number): void {
  db.prepare('DELETE FROM duplicate_runs WHERE id = ?').run(runId);
}

export function finishDuplicateRun(
  db: DatabaseSync,
  runId: number,
  status: 'cancelled' | 'failed',
  finishedAt: number,
): void {
  db.prepare(
    'UPDATE duplicate_runs SET status = ?, finished_at = ?, total_groups = 0, total_files = 0, reclaimable_bytes = 0 WHERE id = ?',
  ).run(status, finishedAt, runId);
}

export function getDuplicateRun(db: DatabaseSync, runId: number): DuplicateRunRecord | null {
  const row = db.prepare('SELECT * FROM duplicate_runs WHERE id = ?').get(runId) as
    | RunRow
    | undefined;
  return row ? mapRun(row) : null;
}

export function getLatestDuplicateRun(db: DatabaseSync): DuplicateRunRecord | null {
  const row = db.prepare('SELECT * FROM duplicate_runs ORDER BY id DESC LIMIT 1').get() as
    | RunRow
    | undefined;
  return row ? mapRun(row) : null;
}

export function insertDuplicateGroups(
  db: DatabaseSync,
  runId: number,
  groups: DuplicateGroupInput[],
): void {
  if (groups.length === 0) return;
  const insertGroup = db.prepare(
    `INSERT INTO duplicate_groups (run_id, size, file_count, reclaimable_bytes, type, mixed_ext)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO duplicate_members (group_id, file_id, path, name, mtime_ms, is_suggested_keep)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const group of groups) {
    const result = insertGroup.run(
      runId,
      group.size,
      group.members.length,
      group.size * (group.members.length - 1),
      group.type,
      group.mixedExt ? 1 : 0,
    );
    const groupId = Number(result.lastInsertRowid);
    for (const member of group.members) {
      insertMember.run(
        groupId,
        member.fileId,
        member.path,
        member.name,
        member.mtimeMs,
        member.suggestedKeep ? 1 : 0,
      );
    }
  }
}

interface GroupRow {
  id: number;
  size: number;
  file_count: number;
  reclaimable_bytes: number;
  type: string;
  mixed_ext: number;
}

interface MemberRow {
  group_id: number;
  file_id: number;
  path: string;
  name: string;
  mtime_ms: number;
  is_suggested_keep: number;
  size: number;
  drive: string;
  ext: string;
  type: string;
}

const GROUP_SORT_SQL: Record<DuplicateQuery['sortBy'], string> = {
  reclaimable: 'g.reclaimable_bytes',
  size: 'g.size',
  count: 'g.file_count',
};

interface GroupWhere {
  sql: string;
  params: Array<string | number>;
}

function buildGroupWhere(runId: number, query: DuplicateQuery): GroupWhere {
  const conditions = ['g.run_id = ?'];
  const params: Array<string | number> = [runId];
  if (query.minSize > 0) {
    conditions.push('g.size >= ?');
    params.push(Math.max(0, Math.floor(query.minSize)));
  }
  if (query.drive) {
    conditions.push(
      'EXISTS (SELECT 1 FROM duplicate_members m JOIN files f ON f.id = m.file_id WHERE m.group_id = g.id AND f.drive = ?)',
    );
    params.push(query.drive);
  }
  if (query.type && query.type !== 'all') {
    conditions.push('g.type = ?');
    params.push(query.type);
  }
  return { sql: conditions.join(' AND '), params };
}

function memberSort(
  a: { mtime_ms: number; path: string },
  b: { mtime_ms: number; path: string },
): number {
  if (a.mtime_ms !== b.mtime_ms) return a.mtime_ms - b.mtime_ms;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
}

function toMember(row: MemberRow): DuplicateMember {
  return {
    fileId: row.file_id,
    path: row.path,
    name: row.name,
    size: row.size,
    mtimeMs: row.mtime_ms,
    drive: row.drive,
    ext: row.ext,
    type: isFileTypeKey(row.type) ? row.type : 'other',
    suggestedKeep: row.is_suggested_keep === 1,
  };
}

export function queryDuplicateGroups(
  db: DatabaseSync,
  runId: number,
  query: DuplicateQuery,
): DuplicateGroupPage {
  const page = Math.max(1, Math.floor(query.page));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize)));
  const where = buildGroupWhere(runId, query);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(g.file_count), 0) AS files,
              COALESCE(SUM(g.reclaimable_bytes), 0) AS reclaimable
       FROM duplicate_groups g WHERE ${where.sql}`,
    )
    .get(...where.params) as { groups: number; files: number; reclaimable: number };

  const sortExpression = GROUP_SORT_SQL[query.sortBy] ?? GROUP_SORT_SQL.reclaimable;
  const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT g.id, g.size, g.file_count, g.reclaimable_bytes, g.type, g.mixed_ext
       FROM duplicate_groups g
       WHERE ${where.sql}
       ORDER BY ${sortExpression} ${direction}, g.size DESC, g.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, pageSize, offset) as unknown as GroupRow[];

  const members = new Map<number, DuplicateMember[]>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ');
    const memberRows = db
      .prepare(
        `SELECT m.group_id, m.file_id, m.path, m.name, m.mtime_ms, m.is_suggested_keep,
                f.size, f.drive, f.ext, f.type
         FROM duplicate_members m JOIN files f ON f.id = m.file_id
         WHERE m.group_id IN (${placeholders})`,
      )
      .all(...rows.map((row) => row.id)) as unknown as MemberRow[];
    const grouped = new Map<number, MemberRow[]>();
    for (const row of memberRows) {
      const list = grouped.get(row.group_id) ?? [];
      list.push(row);
      grouped.set(row.group_id, list);
    }
    const orderedGroupIds = new Set(rows.map((row) => row.id));
    for (const [groupId, list] of grouped) {
      if (!orderedGroupIds.has(groupId)) continue;
      list.sort(memberSort);
      members.set(groupId, list.map(toMember));
    }
  }

  const items: DuplicateGroup[] = rows.map((row) => {
    const list = members.get(row.id) ?? [];
    const extensions = [...new Set(list.map((member) => member.ext.toLowerCase()))].sort();
    const drives = [...new Set(list.map((member) => member.drive))].sort();
    return {
      id: row.id,
      size: row.size,
      fileCount: row.file_count,
      reclaimableBytes: row.reclaimable_bytes,
      type: isFileTypeKey(row.type) ? row.type : 'other',
      mixedExt: extensions.length > 1,
      extensions,
      drives,
      members: list,
    };
  });

  return {
    items,
    total: totals.groups,
    totalFiles: totals.files,
    reclaimableBytes: totals.reclaimable,
    page,
    pageSize,
  };
}

function recalcRunTotals(db: DatabaseSync, runId: number): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(file_count), 0) AS files,
              COALESCE(SUM(reclaimable_bytes), 0) AS reclaimable
       FROM duplicate_groups WHERE run_id = ?`,
    )
    .get(runId) as { groups: number; files: number; reclaimable: number };
  db.prepare(
    'UPDATE duplicate_runs SET total_groups = ?, total_files = ?, reclaimable_bytes = ? WHERE id = ?',
  ).run(row.groups, row.files, row.reclaimable, runId);
}

export function listAffectedGroupIds(
  db: DatabaseSync,
  runId: number,
  fileIds: number[],
): number[] {
  const affected = new Set<number>();
  for (let index = 0; index < fileIds.length; index += 500) {
    const chunk = fileIds.slice(index, index + 500);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT DISTINCT group_id FROM duplicate_members
         WHERE group_id IN (SELECT id FROM duplicate_groups WHERE run_id = ?)
           AND file_id IN (${placeholders})`,
      )
      .all(runId, ...chunk) as Array<{ group_id: number }>;
    for (const row of rows) affected.add(row.group_id);
  }
  return [...affected];
}

export function reconcileDuplicateGroups(db: DatabaseSync, groupIds: number[]): void {
  for (const groupId of groupIds) {
    const group = db
      .prepare('SELECT size FROM duplicate_groups WHERE id = ?')
      .get(groupId) as { size: number } | undefined;
    if (!group) continue;
    const remaining = db
      .prepare(
        `SELECT m.file_id, m.path, m.mtime_ms, m.is_suggested_keep, f.ext, f.type
         FROM duplicate_members m JOIN files f ON f.id = m.file_id
         WHERE m.group_id = ?`,
      )
      .all(groupId) as unknown as Array<{
      file_id: number;
      path: string;
      mtime_ms: number;
      is_suggested_keep: number;
      ext: string;
      type: string;
    }>;
    if (remaining.length < 2) {
      db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(groupId);
      continue;
    }
    remaining.sort(memberSort);
    const keep = remaining[0];
    const extensions = new Set(remaining.map((row) => row.ext.toLowerCase()));
    db.prepare(
      `UPDATE duplicate_groups
       SET file_count = ?, reclaimable_bytes = ?, type = ?, mixed_ext = ?
       WHERE id = ?`,
    ).run(
      remaining.length,
      group.size * (remaining.length - 1),
      isFileTypeKey(keep.type) ? keep.type : 'other',
      extensions.size > 1 ? 1 : 0,
      groupId,
    );
    db.prepare('UPDATE duplicate_members SET is_suggested_keep = 0 WHERE group_id = ?').run(
      groupId,
    );
    db.prepare(
      'UPDATE duplicate_members SET is_suggested_keep = 1 WHERE group_id = ? AND file_id = ?',
    ).run(groupId, keep.file_id);
  }
}

export function reconcileDuplicateRunAfterDelete(
  db: DatabaseSync,
  runId: number,
  groupIds: number[],
): void {
  reconcileDuplicateGroups(db, groupIds);
  recalcRunTotals(db, runId);
}

export function removeDuplicateMembers(
  db: DatabaseSync,
  runId: number,
  fileIds: number[],
): number {
  if (fileIds.length === 0) return 0;
  const unique = [...new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return 0;

  let removed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const affected = listAffectedGroupIds(db, runId, unique);
    for (let index = 0; index < unique.length; index += 500) {
      const chunk = unique.slice(index, index + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = db
        .prepare(
          `DELETE FROM duplicate_members
           WHERE group_id IN (SELECT id FROM duplicate_groups WHERE run_id = ?)
             AND file_id IN (${placeholders})`,
        )
        .run(runId, ...chunk);
      removed += Number(result.changes);
    }

    reconcileDuplicateGroups(db, affected);
    recalcRunTotals(db, runId);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction may already be rolled back.
    }
    throw error;
  }
  return removed;
}
