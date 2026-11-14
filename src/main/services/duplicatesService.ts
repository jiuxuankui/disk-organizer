import type { DatabaseSync } from 'node:sqlite';
import type {
  DuplicateGroupPage,
  DuplicateQuery,
  DuplicatesState,
  FileTypeKey,
} from '@shared/types';
import { isFileTypeKey } from '@shared/fileTypes';
import { getActiveScanId, getActiveScanSummary } from '../db/scansRepo';
import {
  clearDuplicateRuns,
  createDuplicateRun,
  finalizeDuplicateRun,
  finishDuplicateRun,
  getLatestDuplicateRun,
  insertDuplicateGroups,
  listDuplicateCandidates,
  queryDuplicateGroups,
  removeDuplicateMembers,
  type CandidateRow,
  type DuplicateGroupInput,
} from '../db/duplicatesRepo';
import {
  getHashCacheRows,
  upsertFullHash,
  upsertQuickHash,
  type HashCacheRow,
} from '../db/hashCacheRepo';
import {
  HashCancelledError,
  type HashRunnerFactory,
  type HashWorkItem,
  type HashWorkResult,
} from './hashRunner';

export interface DuplicatesServiceDeps {
  db: DatabaseSync;
  getDefaultMinSize: () => number;
  runnerFactory: HashRunnerFactory;
  emit?: (state: DuplicatesState) => void;
  now?: () => number;
}

interface ActiveRun {
  runId: number;
  scanId: number;
  controller: AbortController;
  finishing: boolean;
}

function suggestionCompare(
  a: { mtimeMs: number; path: string },
  b: { mtimeMs: number; path: string },
): number {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
}

function identityKey(row: CandidateRow): string {
  if (row.volume_id && row.file_id) return `${row.volume_id}:${row.file_id}`;
  return `path:${row.path_key}`;
}

function dedupeHardLinks(rows: CandidateRow[]): CandidateRow[] {
  const byIdentity = new Map<string, CandidateRow>();
  for (const row of rows) {
    const key = identityKey(row);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, row);
      continue;
    }
    if (
      suggestionCompare(
        { mtimeMs: row.mtime_ms, path: row.path },
        { mtimeMs: existing.mtime_ms, path: existing.path },
      ) < 0
    ) {
      byIdentity.set(key, row);
    }
  }
  return [...byIdentity.values()];
}

function cacheValid(row: HashCacheRow | undefined, candidate: CandidateRow): boolean {
  return (
    row !== undefined &&
    row.size === candidate.size &&
    row.mtime_ms === candidate.mtime_ms
  );
}

function emptyState(
  scanId: number | null,
  minSize: number,
  drives: string[] = [],
): DuplicatesState {
  return {
    runId: null,
    scanId,
    status: 'idle',
    stage: null,
    drives,
    minSize,
    quickChecked: 0,
    quickTotal: 0,
    fullChecked: 0,
    fullTotal: 0,
    etaMs: null,
    groups: 0,
    files: 0,
    reclaimableBytes: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    needsRefresh: false,
  };
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export class DuplicatesService {
  private readonly db: DatabaseSync;
  private readonly getDefaultMinSize: () => number;
  private readonly runnerFactory: HashRunnerFactory;
  private readonly emitState: (state: DuplicatesState) => void;
  private readonly now: () => number;

  private active: ActiveRun | null = null;
  private state: DuplicatesState;
  private lastEmitAt = 0;
  private idleResolve: (() => void) | null = null;
  private idlePromise: Promise<void> = Promise.resolve();

  constructor(deps: DuplicatesServiceDeps) {
    this.db = deps.db;
    this.getDefaultMinSize = deps.getDefaultMinSize;
    this.runnerFactory = deps.runnerFactory;
    this.emitState = deps.emit ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.state = this.readPersistedState();
  }

  private scanDriveLetters(scanId: number): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT drive FROM files WHERE scan_id = ? ORDER BY drive')
      .all(scanId) as Array<{ drive: string }>;
    return rows.map((row) => row.drive);
  }

  private availableDrives(scanId: number, summaryDrives: string[]): string[] {
    const indexed = this.scanDriveLetters(scanId);
    if (indexed.length > 0) return indexed;
    return summaryDrives.filter((drive) => /^[A-Za-z]:?$/.test(drive));
  }

  private readPersistedState(): DuplicatesState {
    const activeScanId = getActiveScanId(this.db);
    const defaultMinSize = this.getDefaultMinSize();
    if (activeScanId === null) return emptyState(null, defaultMinSize);

    const latest = getLatestDuplicateRun(this.db);
    const summary = getActiveScanSummary(this.db);
    const scanDrives = this.availableDrives(activeScanId, summary?.drives ?? []);
    if (!latest) return emptyState(activeScanId, defaultMinSize, scanDrives);

    const runDrives = latest.drives.length > 0 ? latest.drives : scanDrives;
    const base: DuplicatesState = {
      runId: latest.id,
      scanId: latest.scanId,
      status: latest.status === 'running' ? 'cancelled' : 'completed',
      stage: null,
      drives: runDrives,
      minSize: latest.minSize,
      quickChecked: 0,
      quickTotal: 0,
      fullChecked: 0,
      fullTotal: 0,
      etaMs: null,
      groups: latest.totalGroups,
      files: latest.totalFiles,
      reclaimableBytes: latest.reclaimableBytes,
      startedAt: latest.createdAt,
      finishedAt: latest.finishedAt,
      error: null,
      needsRefresh: false,
    };

    if (latest.status === 'completed' && latest.scanId === activeScanId) {
      return base;
    }
    if (latest.status === 'stale' || latest.status === 'completed') {
      return { ...base, status: 'stale', needsRefresh: true };
    }
    if (latest.status === 'failed') {
      return { ...base, status: 'failed', error: '上次重复查找失败，可重新查找' };
    }
    return { ...base, status: 'cancelled' };
  }

  getState(): DuplicatesState {
    if (this.active) return this.withEta(this.state);
    return this.readPersistedState();
  }

  private withEta(state: DuplicatesState): DuplicatesState {
    if (state.status !== 'running' || state.startedAt === null) return state;
    const checked = state.stage === 'full' ? state.fullChecked : state.quickChecked;
    const total = state.stage === 'full' ? state.fullTotal : state.quickTotal;
    if (checked <= 0 || total <= checked) return { ...state, etaMs: null };
    const elapsed = Math.max(0, this.now() - state.startedAt);
    const etaMs = Math.round((elapsed / checked) * (total - checked));
    return { ...state, etaMs };
  }

  isRunning(): boolean {
    return this.active !== null && !this.active.finishing;
  }

  whenIdle(): Promise<void> {
    return this.idlePromise;
  }

  private finishIdle(): void {
    const resolve = this.idleResolve;
    this.idleResolve = null;
    resolve?.();
  }

  private emit(force = false): void {
    const now = this.now();
    if (!force && now - this.lastEmitAt < 150) return;
    this.lastEmitAt = now;
    this.emitState(this.getState());
  }

  recover(): void {
    try {
      this.db
        .prepare("UPDATE duplicate_runs SET status = 'cancelled', finished_at = ? WHERE status = 'running'")
        .run(this.now());
    } catch {
      // Recovery is best effort; the page will still let the user re-run.
    }
    this.state = this.readPersistedState();
  }

  private resolveDrives(requested: string[] | undefined, available: string[]): string[] {
    if (requested === undefined) return [...available];
    const allowed = new Set(available.map((drive) => drive.toUpperCase()));
    const unique = [...new Set(requested.map((drive) => drive.trim().toUpperCase()))];
    if (unique.length === 0) throw new Error('请至少选择一块硬盘');
    const unknown = unique.filter((drive) => !allowed.has(drive));
    if (unknown.length > 0) {
      throw new Error(`所选硬盘不在本次扫描范围内：${unknown.join('、')}`);
    }
    return unique;
  }

  start(drives?: string[]): DuplicatesState {
    if (this.active) throw new Error('已有重复查找正在进行');
    const summary = getActiveScanSummary(this.db);
    if (!summary) throw new Error('还没有可用的扫描数据，请先完成一次扫描');

    const selectedDrives = this.resolveDrives(
      drives,
      this.availableDrives(summary.id, summary.drives),
    );
    const minSize = Math.max(0, Math.floor(this.getDefaultMinSize()));
    clearDuplicateRuns(this.db);
    const runId = createDuplicateRun(this.db, summary.id, minSize, this.now(), selectedDrives);
    const controller = new AbortController();
    this.active = { runId, scanId: summary.id, controller, finishing: false };

    this.state = {
      ...emptyState(summary.id, minSize, selectedDrives),
      runId,
      status: 'running',
      stage: 'quick',
      startedAt: this.now(),
    };
    this.lastEmitAt = 0;
    this.emit(true);

    this.idlePromise = new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });
    void this
      .execute(runId, summary.id, minSize, selectedDrives, controller.signal)
      .finally(() => this.finishIdle());
    return this.getState();
  }

  cancel(): DuplicatesState {
    const active = this.active;
    if (active && !active.finishing) {
      active.controller.abort();
    }
    return this.getState();
  }

  private async execute(
    runId: number,
    scanId: number,
    minSize: number,
    drives: string[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const candidates = dedupeHardLinks(
        listDuplicateCandidates(this.db, scanId, minSize, drives),
      );
      this.state = {
        ...this.state,
        quickTotal: candidates.length,
        stage: 'quick',
      };
      this.emit(true);

      const cacheRows = getHashCacheRows(
        this.db,
        candidates.map((row) => row.path_key),
      );
      const quickHashes = new Map<number, string>();
      const quickFirstChecks = new Map<number, string>();
      const failed = new Set<number>();
      const quickTasks: HashWorkItem[] = [];
      let quickChecked = 0;

      for (const candidate of candidates) {
        const cached = cacheRows.get(candidate.path_key);
        if (cacheValid(cached, candidate) && cached?.quick_hash) {
          quickHashes.set(candidate.id, cached.quick_hash);
          if (candidate.size <= 64 * 1024) {
            quickFirstChecks.set(candidate.id, cached.quick_hash);
          }
          quickChecked += 1;
        } else {
          quickTasks.push({
            id: candidate.id,
            path: candidate.path,
            size: candidate.size,
            mtimeMs: candidate.mtime_ms,
            mode: 'quick',
          });
        }
      }

      this.state = { ...this.state, quickChecked };
      this.emit(true);

      const runner = this.runnerFactory();
      let quickResults: HashWorkResult[] = [];
      if (quickTasks.length > 0) {
        quickResults = await runner.run(quickTasks, {
          signal,
          onResult: () => {
            quickChecked += 1;
            this.state = { ...this.state, quickChecked };
            this.emit();
          },
        });
      }

      const candidateById = new Map(candidates.map((row) => [row.id, row]));
      for (const result of quickResults) {
        if (result.failure || !result.quickHash) {
          failed.add(result.id);
          continue;
        }
        quickHashes.set(result.id, result.quickHash);
        const candidate = candidateById.get(result.id);
        if (candidate && candidate.size <= 64 * 1024 && result.fullHash) {
          quickFirstChecks.set(result.id, result.fullHash);
        }
      }
      this.persistQuickHashes(quickResults, candidateById);

      if (signal.aborted) throw new HashCancelledError();

      const quickGroups = groupBy(
        candidates.filter((row) => !failed.has(row.id) && quickHashes.has(row.id)),
        (row) => `${row.size}:${quickHashes.get(row.id)}`,
      );
      const fullCandidates: CandidateRow[] = [];
      for (const group of quickGroups.values()) {
        if (group.length >= 2) fullCandidates.push(...group);
      }

      const fullHashes = new Map<number, string>();
      const fullTasks: HashWorkItem[] = [];
      const fullCacheRows = getHashCacheRows(
        this.db,
        fullCandidates.map((row) => row.path_key),
      );
      let fullChecked = 0;
      for (const candidate of fullCandidates) {
        const quickHash = quickHashes.get(candidate.id);
        const smallFull = quickFirstChecks.get(candidate.id);
        if (smallFull) {
          fullHashes.set(candidate.id, smallFull);
          fullChecked += 1;
          continue;
        }
        const cached = fullCacheRows.get(candidate.path_key);
        if (
          cacheValid(cached, candidate) &&
          cached?.full_hash &&
          cached.quick_hash === quickHash
        ) {
          fullHashes.set(candidate.id, cached.full_hash);
          fullChecked += 1;
          continue;
        }
        fullTasks.push({
          id: candidate.id,
          path: candidate.path,
          size: candidate.size,
          mtimeMs: candidate.mtime_ms,
          mode: 'full',
        });
      }

      this.state = {
        ...this.state,
        stage: 'full',
        fullTotal: fullCandidates.length,
        fullChecked,
      };
      this.emit(true);

      let fullResults: HashWorkResult[] = [];
      if (fullTasks.length > 0) {
        fullResults = await runner.run(fullTasks, {
          signal,
          onResult: () => {
            fullChecked += 1;
            this.state = { ...this.state, fullChecked };
            this.emit();
          },
        });
      }

      for (const result of fullResults) {
        if (result.failure || !result.fullHash) {
          failed.add(result.id);
          continue;
        }
        fullHashes.set(result.id, result.fullHash);
      }
      this.persistFullHashes(fullResults, candidateById);

      if (signal.aborted) throw new HashCancelledError();

      const fullGroups = groupBy(
        fullCandidates.filter((row) => !failed.has(row.id) && fullHashes.has(row.id)),
        (row) => `${row.size}:${fullHashes.get(row.id)}`,
      );

      const groups: DuplicateGroupInput[] = [];
      for (const rows of fullGroups.values()) {
        if (rows.length < 2) continue;
        const members = [...rows].sort((a, b) =>
          suggestionCompare(
            { mtimeMs: a.mtime_ms, path: a.path },
            { mtimeMs: b.mtime_ms, path: b.path },
          ),
        );
        const extensions = new Set(members.map((row) => row.ext.toLowerCase()));
        const keepType = members[0].type;
        groups.push({
          size: members[0].size,
          type: isFileTypeKey(keepType) ? (keepType as FileTypeKey) : 'other',
          mixedExt: extensions.size > 1,
          members: members.map((row, index) => ({
            fileId: row.id,
            path: row.path,
            name: row.name,
            mtimeMs: row.mtime_ms,
            suggestedKeep: index === 0,
          })),
        });
      }

      const totalFiles = groups.reduce((sum, group) => sum + group.members.length, 0);
      const reclaimableBytes = groups.reduce(
        (sum, group) => sum + group.size * (group.members.length - 1),
        0,
      );

      this.db.exec('BEGIN IMMEDIATE');
      try {
        insertDuplicateGroups(this.db, runId, groups);
        finalizeDuplicateRun(this.db, runId, {
          groups: groups.length,
          files: totalFiles,
          reclaimableBytes,
          finishedAt: this.now(),
        });
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Transaction may already be rolled back.
        }
        throw error;
      }

      const finishedAt = this.now();
      this.state = {
        ...emptyState(scanId, minSize, drives),
        runId,
        status: 'completed',
        quickChecked: candidates.length,
        quickTotal: candidates.length,
        fullChecked: fullCandidates.length,
        fullTotal: fullCandidates.length,
        groups: groups.length,
        files: totalFiles,
        reclaimableBytes,
        startedAt: this.state.startedAt,
        finishedAt,
      };
      this.active = null;
      this.emit(true);
    } catch (error) {
      const finishedAt = this.now();
      const cancelled = error instanceof HashCancelledError || signal.aborted;
      try {
        finishDuplicateRun(
          this.db,
          runId,
          cancelled ? 'cancelled' : 'failed',
          finishedAt,
        );
      } catch {
        // The failed run will be cleaned on the next start.
      }
      this.state = {
        ...this.state,
        status: cancelled ? 'cancelled' : 'failed',
        stage: null,
        etaMs: null,
        groups: 0,
        files: 0,
        reclaimableBytes: 0,
        finishedAt,
        error: cancelled
          ? null
          : error instanceof Error
            ? error.message
            : String(error),
      };
      this.active = null;
      this.emit(true);
    }
  }

  private persistQuickHashes(
    results: HashWorkResult[],
    candidates: Map<number, CandidateRow>,
  ): void {
    const now = this.now();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const result of results) {
        const candidate = candidates.get(result.id);
        if (!candidate || result.failure || !result.quickHash) continue;
        upsertQuickHash(
          this.db,
          candidate.path_key,
          candidate.size,
          candidate.mtime_ms,
          result.quickHash,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Cache writes are best effort.
      }
    }
  }

  private persistFullHashes(
    results: HashWorkResult[],
    candidates: Map<number, CandidateRow>,
  ): void {
    const now = this.now();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const result of results) {
        const candidate = candidates.get(result.id);
        if (!candidate || result.failure || !result.quickHash || !result.fullHash) continue;
        upsertFullHash(
          this.db,
          candidate.path_key,
          candidate.size,
          candidate.mtime_ms,
          result.quickHash,
          result.fullHash,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Cache writes are best effort.
      }
    }
  }

  private completedRunId(): number | null {
    const activeScanId = getActiveScanId(this.db);
    if (activeScanId === null) return null;
    const latest = getLatestDuplicateRun(this.db);
    if (!latest || latest.status !== 'completed' || latest.scanId !== activeScanId) return null;
    return latest.id;
  }

  query(query: DuplicateQuery): DuplicateGroupPage {
    const runId = this.completedRunId();
    if (runId === null) {
      return {
        items: [],
        total: 0,
        totalFiles: 0,
        reclaimableBytes: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    }
    return queryDuplicateGroups(this.db, runId, query);
  }

  removeFiles(fileIds: number[]): number {
    const runId = this.completedRunId();
    if (runId === null) return 0;
    return removeDuplicateMembers(this.db, runId, fileIds);
  }
}
