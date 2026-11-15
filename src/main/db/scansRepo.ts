import type { DatabaseSync } from 'node:sqlite';
import type { ScanStatus, ScanSummary, SkippedSummary, SkipReason } from '@shared/types';
import { SKIPPED_SAMPLE_LIMIT } from '@shared/constants';

export interface ScanRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  drives_json: string;
  total_files: number;
  identified_bytes: number;
  skipped_json: string;
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteMeta(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function createScan(db: DatabaseSync, drives: string[], now: number): number {
  const result = db
    .prepare("INSERT INTO scans (started_at, status, drives_json) VALUES (?, 'running', ?)")
    .run(now, JSON.stringify(drives));
  return Number(result.lastInsertRowid);
}

export function updateScanStatus(
  db: DatabaseSync,
  scanId: number,
  status: Extract<ScanStatus, 'cancelled' | 'failed'>,
  now: number,
): void {
  db.prepare('UPDATE scans SET status = ?, finished_at = ? WHERE id = ?').run(status, now, scanId);
}

export function finalizeScan(
  db: DatabaseSync,
  scanId: number,
  data: {
    totalFiles: number;
    identifiedBytes: number;
    skipped: SkippedSummary[];
    finishedAt: number;
  },
): void {
  db.prepare(
    'UPDATE scans SET status = ?, finished_at = ?, total_files = ?, identified_bytes = ?, skipped_json = ? WHERE id = ?',
  ).run(
    'completed',
    data.finishedAt,
    data.totalFiles,
    data.identifiedBytes,
    JSON.stringify(data.skipped),
    scanId,
  );
}

export function getScanRow(db: DatabaseSync, scanId: number): ScanRow | null {
  return (
    (db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as ScanRow | undefined) ?? null
  );
}

export function getActiveScanId(db: DatabaseSync): number | null {
  const raw = getMeta(db, 'active_scan_id');
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function setActiveScanId(db: DatabaseSync, scanId: number): void {
  setMeta(db, 'active_scan_id', String(scanId));
}

function parseSkipped(raw: string): SkippedSummary[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is SkippedSummary => {
        if (typeof item !== 'object' || item === null) return false;
        const record = item as Record<string, unknown>;
        return typeof record.reason === 'string' && typeof record.count === 'number';
      })
      .map((item) => ({
        reason: item.reason as SkipReason,
        count: item.count,
        samples: Array.isArray(item.samples)
          ? item.samples.filter((s): s is string => typeof s === 'string').slice(0, SKIPPED_SAMPLE_LIMIT)
          : [],
      }));
  } catch {
    return [];
  }
}

export function mapScanSummary(row: ScanRow): ScanSummary {
  let drives: string[] = [];
  try {
    const parsed = JSON.parse(row.drives_json) as unknown;
    if (Array.isArray(parsed)) drives = parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    drives = [];
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as ScanStatus,
    drives,
    totalFiles: row.total_files,
    identifiedBytes: row.identified_bytes,
    skipped: parseSkipped(row.skipped_json),
  };
}

export function getScanSummary(db: DatabaseSync, scanId: number): ScanSummary | null {
  const row = getScanRow(db, scanId);
  return row ? mapScanSummary(row) : null;
}

export function getActiveScanSummary(db: DatabaseSync): ScanSummary | null {
  const activeId = getActiveScanId(db);
  if (activeId === null) return null;
  const summary = getScanSummary(db, activeId);
  if (!summary || summary.status !== 'completed') return null;
  return summary;
}

export function countScanFiles(db: DatabaseSync, scanId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?').get(scanId) as {
    c: number;
  };
  return row.c;
}

export function deleteScanData(db: DatabaseSync, scanId: number, batchSize = 5000): void {
  const deleteFiles = db.prepare(
    'DELETE FROM files WHERE id IN (SELECT id FROM files WHERE scan_id = ? LIMIT ?)',
  );
  for (;;) {
    const result = deleteFiles.run(scanId, batchSize);
    if (Number(result.changes) === 0) break;
  }
  const deleteStaging = db.prepare(
    'DELETE FROM scan_staging WHERE scan_id = ? AND path_key IN (SELECT path_key FROM scan_staging WHERE scan_id = ? LIMIT ?)',
  );
  for (;;) {
    const result = deleteStaging.run(scanId, scanId, batchSize);
    if (Number(result.changes) === 0) break;
  }
}

export function markOtherDuplicateRunsStale(db: DatabaseSync, activeScanId: number): void {
  db.prepare(
    `UPDATE duplicate_runs
     SET status = 'stale', total_groups = 0, total_files = 0, reclaimable_bytes = 0
     WHERE scan_id != ?`,
  ).run(activeScanId);
  db.prepare(
    'DELETE FROM duplicate_groups WHERE run_id IN (SELECT id FROM duplicate_runs WHERE scan_id != ?)',
  ).run(activeScanId);
}

export function pruneHashCache(db: DatabaseSync, activeScanId: number): number {
  const result = db
    .prepare(
      `DELETE FROM hash_cache
       WHERE NOT EXISTS (
         SELECT 1 FROM files f
         WHERE f.scan_id = ?
           AND f.path_key = hash_cache.path_key
           AND f.size = hash_cache.size
           AND f.mtime_ms = hash_cache.mtime_ms
       )`,
    )
    .run(activeScanId);
  return Number(result.changes);
}

export function listRunningScanIds(db: DatabaseSync): number[] {
  return (db.prepare("SELECT id FROM scans WHERE status = 'running'").all() as Array<{ id: number }>).map(
    (row) => row.id,
  );
}

export function listOtherScanIds(db: DatabaseSync, activeScanId: number): number[] {
  return (
    db.prepare('SELECT id FROM scans WHERE id != ? ORDER BY id DESC').all(activeScanId) as Array<{
      id: number;
    }>
  ).map((row) => row.id);
}

export function listScanIds(db: DatabaseSync): number[] {
  return (db.prepare('SELECT id FROM scans ORDER BY id DESC').all() as Array<{ id: number }>).map(
    (row) => row.id,
  );
}

export type { SkipReason };
