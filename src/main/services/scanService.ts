import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { ScanProgress, ScanStatus, ScanSummary, SkippedSummary } from '@shared/types';
import { SCAN_BATCH_SIZE } from '@shared/constants';
import {
  createScan,
  deleteMeta,
  deleteScanData,
  finalizeScan,
  getActiveScanId,
  getActiveScanSummary,
  getMeta,
  getScanRow,
  getScanSummary,
  listOtherScanIds,
  listRunningScanIds,
  setActiveScanId,
  setMeta,
  updateScanStatus,
} from '../db/scansRepo';
import type { ScanWorkerData, ScanWorkerOutbound } from '../workers/protocols';

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | number | void;
}

export type ScanWorkerFactory = (data: ScanWorkerData) => WorkerLike;

export interface ScanStartOptions {
  drives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
  batchSize?: number;
  allowAbsoluteRoots?: boolean;
}

export type ScanServiceEvent =
  | { type: 'state'; state: ScanProgress }
  | { type: 'completed'; scan: ScanSummary }
  | { type: 'cancelled'; scanId: number }
  | { type: 'failed'; message: string };

export interface ScanServiceDeps {
  db: DatabaseSync;
  dbPath: string;
  workerFactory: ScanWorkerFactory;
  emit?: (event: ScanServiceEvent) => void;
  now?: () => number;
  cancelTimeoutMs?: number;
}

interface ActiveRun {
  scanId: number;
  worker: WorkerLike;
  finishing: boolean;
  cancelRequested: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

function idleState(): ScanProgress {
  return {
    scanId: null,
    status: 'idle',
    phase: 'idle',
    drives: [],
    currentPath: '',
    filesFound: 0,
    filesProcessed: 0,
    bytesProcessed: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export class ScanService {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly workerFactory: ScanWorkerFactory;
  private readonly emit: (event: ScanServiceEvent) => void;
  private readonly now: () => number;
  private readonly cancelTimeoutMs: number;

  private state: ScanProgress;
  private run: ActiveRun | null = null;
  private idleResolve: (() => void) | null = null;
  private idlePromise: Promise<void> = Promise.resolve();

  constructor(deps: ScanServiceDeps) {
    this.db = deps.db;
    this.dbPath = deps.dbPath;
    this.workerFactory = deps.workerFactory;
    this.emit = deps.emit ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.cancelTimeoutMs = deps.cancelTimeoutMs ?? 15000;
    this.state = this.readInitialState();
  }

  private readInitialState(): ScanProgress {
    const summary = getActiveScanSummary(this.db);
    if (!summary) return idleState();
    return {
      ...idleState(),
      scanId: summary.id,
      status: 'completed',
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      drives: summary.drives,
      filesFound: summary.totalFiles,
      filesProcessed: summary.totalFiles,
      bytesProcessed: summary.identifiedBytes,
    };
  }

  getState(): ScanProgress {
    return { ...this.state, drives: [...this.state.drives] };
  }

  isScanning(): boolean {
    return this.run !== null && !this.run.finishing;
  }

  isBusy(): boolean {
    return this.run !== null;
  }

  whenIdle(): Promise<void> {
    return this.idlePromise;
  }

  start(options: ScanStartOptions): ScanProgress {
    if (this.isScanning()) throw new Error('已有扫描正在进行');
    const drives: string[] = [];
    for (const raw of options.drives) {
      const trimmed = raw.trim();
      const match = /^([A-Za-z]):\\?$/.exec(trimmed);
      let value = '';
      if (match) {
        value = `${match[1].toUpperCase()}:`;
      } else if (options.allowAbsoluteRoots && path.isAbsolute(trimmed)) {
        value = trimmed.replace(/\\+$/, '');
      }
      if (!value) continue;
      if (!drives.includes(value)) drives.push(value);
    }
    if (drives.length === 0) throw new Error('请先选择要扫描的硬盘');

    const scanId = createScan(this.db, drives, this.now());
    this.state = {
      scanId,
      status: 'enumerating',
      phase: 'enumerating',
      drives,
      currentPath: '',
      filesFound: 0,
      filesProcessed: 0,
      bytesProcessed: 0,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
    };
    this.emit({ type: 'state', state: this.getState() });

    this.idlePromise = new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });

    const worker = this.workerFactory({
      scanId,
      dbPath: this.dbPath,
      drives,
      excludedPaths: options.excludedPaths,
      skipHiddenSystem: options.skipHiddenSystem,
      batchSize: options.batchSize ?? SCAN_BATCH_SIZE,
    });
    const run: ActiveRun = {
      scanId,
      worker,
      finishing: false,
      cancelRequested: false,
      cancelTimer: null,
    };
    this.run = run;

    worker.on('message', (message) => this.handleMessage(scanId, message as ScanWorkerOutbound));
    worker.on('error', (error) => {
      this.failRun(scanId, error instanceof Error ? error.message : String(error));
    });
    worker.on('exit', (code) => {
      if (!run.finishing) {
        this.failRun(scanId, `扫描进程意外退出（代码 ${code}）`);
      }
    });

    return this.getState();
  }

  pause(): void {
    if (!this.run || this.run.finishing) return;
    if (this.state.status === 'paused') return;
    this.run.worker.postMessage({ type: 'pause' });
  }

  resume(): void {
    if (!this.run || this.run.finishing) return;
    if (this.state.status !== 'paused') return;
    this.run.worker.postMessage({ type: 'resume' });
    this.state = {
      ...this.state,
      status: this.state.phase === 'indexing' ? 'indexing' : 'enumerating',
    };
    this.emit({ type: 'state', state: this.getState() });
  }

  cancel(): void {
    const run = this.run;
    if (!run || run.finishing || run.cancelRequested) return;
    run.cancelRequested = true;
    run.worker.postMessage({ type: 'cancel' });
    run.cancelTimer = setTimeout(() => {
      if (!run.finishing) {
        this.forceStop(run.scanId, 'cancelled');
      }
    }, this.cancelTimeoutMs);
  }

  private handleMessage(scanId: number, message: ScanWorkerOutbound): void {
    const run = this.run;
    if (!run || run.scanId !== scanId || run.finishing) return;

    switch (message.type) {
      case 'phase': {
        this.state = {
          ...this.state,
          status: (message.phase === 'indexing' ? 'indexing' : 'enumerating') as ScanStatus,
          phase: message.phase,
        };
        this.emit({ type: 'state', state: this.getState() });
        return;
      }
      case 'progress': {
        this.state = {
          ...this.state,
          filesFound: message.progress.filesFound,
          filesProcessed: message.progress.filesProcessed,
          bytesProcessed: message.progress.bytesProcessed,
          currentPath: message.progress.currentPath,
        };
        this.emit({ type: 'state', state: this.getState() });
        return;
      }
      case 'paused': {
        this.state = { ...this.state, status: 'paused' };
        this.emit({ type: 'state', state: this.getState() });
        return;
      }
      case 'cancelled': {
        this.finalizeCancel(scanId);
        return;
      }
      case 'error': {
        this.failRun(scanId, message.message);
        return;
      }
      case 'done': {
        this.finalizeCommit(scanId, message);
      }
    }
  }

  private clearCancelTimer(run: ActiveRun): void {
    if (run.cancelTimer) {
      clearTimeout(run.cancelTimer);
      run.cancelTimer = null;
    }
  }

  private finishIdle(): void {
    const resolve = this.idleResolve;
    this.idleResolve = null;
    this.run = null;
    resolve?.();
  }

  private finalizeCommit(
    scanId: number,
    result: { totalFiles: number; identifiedBytes: number; skipped: SkippedSummary[] },
  ): void {
    const run = this.run;
    if (!run || run.scanId !== scanId || run.finishing) return;
    run.finishing = true;
    this.clearCancelTimer(run);

    const finishedAt = this.now();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        finalizeScan(this.db, scanId, {
          totalFiles: result.totalFiles,
          identifiedBytes: result.identifiedBytes,
          skipped: result.skipped,
          finishedAt,
        });
        setActiveScanId(this.db, scanId);
        setMeta(this.db, 'last_scan_finished_at', String(finishedAt));
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Transaction may already be rolled back.
        }
        throw error;
      }
    } catch (error) {
      this.markFailedAfterCommit(
        scanId,
        `保存扫描结果失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const summary = getScanSummary(this.db, scanId);
    this.state = {
      ...this.state,
      status: 'completed',
      phase: 'idle',
      filesFound: result.totalFiles,
      filesProcessed: result.totalFiles,
      bytesProcessed: result.identifiedBytes,
      finishedAt,
      error: null,
    };
    this.emit({ type: 'state', state: this.getState() });
    if (summary) this.emit({ type: 'completed', scan: summary });

    void this.cleanupAfterCommit(scanId)
      .catch(() => {
        // Old snapshot cleanup is best effort; the new snapshot is already active.
      })
      .finally(() => this.finishIdle());
  }

  private finalizeCancel(scanId: number): void {
    const run = this.run;
    if (!run || run.scanId !== scanId || run.finishing) return;
    run.finishing = true;
    this.clearCancelTimer(run);
    const finishedAt = this.now();
    try {
      updateScanStatus(this.db, scanId, 'cancelled', finishedAt);
      deleteScanData(this.db, scanId);
    } catch {
      // Keep the app usable even if cleanup fails; active snapshot is untouched.
    }
    this.state = {
      ...this.state,
      status: 'cancelled',
      phase: 'idle',
      finishedAt,
      error: null,
    };
    this.emit({ type: 'state', state: this.getState() });
    this.emit({ type: 'cancelled', scanId });
    this.finishIdle();
  }

  private forceStop(scanId: number, mode: 'cancelled'): void {
    const run = this.run;
    if (!run || run.scanId !== scanId || run.finishing) return;
    run.finishing = true;
    this.clearCancelTimer(run);
    try {
      void run.worker.terminate();
    } catch {
      // Worker may already be gone.
    }
    if (mode === 'cancelled') {
      const finishedAt = this.now();
      try {
        updateScanStatus(this.db, scanId, 'cancelled', finishedAt);
        deleteScanData(this.db, scanId);
      } catch {
        // Cleanup is best effort.
      }
      this.state = {
        ...this.state,
        status: 'cancelled',
        phase: 'idle',
        finishedAt,
        error: null,
      };
      this.emit({ type: 'state', state: this.getState() });
      this.emit({ type: 'cancelled', scanId });
    }
    this.finishIdle();
  }

  private failRun(scanId: number, message: string): void {
    const run = this.run;
    if (!run || run.scanId !== scanId || run.finishing) return;
    run.finishing = true;
    this.clearCancelTimer(run);
    let termination: Promise<unknown>;
    try {
      termination = Promise.resolve(run.worker.terminate());
    } catch {
      termination = Promise.resolve();
    }
    void termination
      .catch(() => undefined)
      .finally(() => {
        try {
          updateScanStatus(this.db, scanId, 'failed', this.now());
          deleteScanData(this.db, scanId);
        } catch {
          // The active snapshot remains untouched even if cleanup fails.
        }
        this.state = {
          ...this.state,
          status: 'failed',
          phase: 'idle',
          finishedAt: this.now(),
          error: message,
        };
        this.emit({ type: 'state', state: this.getState() });
        this.emit({ type: 'failed', message });
        this.finishIdle();
      });
  }

  private markFailedAfterCommit(scanId: number, message: string): void {
    try {
      updateScanStatus(this.db, scanId, 'failed', this.now());
      deleteScanData(this.db, scanId);
    } catch {
      // The previous active snapshot is still intact.
    }
    this.state = {
      ...this.state,
      status: 'failed',
      phase: 'idle',
      finishedAt: this.now(),
      error: message,
    };
    this.emit({ type: 'state', state: this.getState() });
    this.emit({ type: 'failed', message });
    this.finishIdle();
  }

  private async cleanupAfterCommit(activeScanId: number): Promise<void> {
    const others = listOtherScanIds(this.db, activeScanId);
    for (const scanId of others) {
      deleteScanData(this.db, scanId);
    }
  }

  recover(): { recoveredRunning: number[]; activeScanId: number | null } {
    const runningIds = listRunningScanIds(this.db);
    const now = this.now();
    for (const scanId of runningIds) {
      try {
        updateScanStatus(this.db, scanId, 'failed', now);
        deleteScanData(this.db, scanId);
      } catch {
        // Continue recovering the remaining scans.
      }
    }

    let activeScanId = getActiveScanId(this.db);
    if (activeScanId !== null) {
      const row = getScanRow(this.db, activeScanId);
      if (!row || row.status !== 'completed') {
        deleteMeta(this.db, 'active_scan_id');
        activeScanId = null;
      }
    }

    if (activeScanId !== null) {
      for (const scanId of listOtherScanIds(this.db, activeScanId)) {
        try {
          deleteScanData(this.db, scanId);
        } catch {
          // Recovery continues with the next snapshot.
        }
      }
    }

    this.state = this.readInitialState();
    return { recoveredRunning: runningIds, activeScanId };
  }

  getLastScanFinishedAt(): number | null {
    const raw = getMeta(this.db, 'last_scan_finished_at');
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
}
