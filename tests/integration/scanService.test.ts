import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/main/db/connection';
import {
  createScan,
  getActiveScanId,
  getScanRow,
  setActiveScanId,
  setMeta,
} from '../../src/main/db/scansRepo';
import {
  ScanService,
  type ScanServiceEvent,
  type ScanWorkerFactory,
  type WorkerLike,
} from '../../src/main/services/scanService';
import type { ScanWorkerInbound } from '../../src/main/workers/protocols';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

class FakeWorker implements WorkerLike {
  readonly posted: ScanWorkerInbound[] = [];
  terminated = false;
  private readonly listeners: Record<string, Set<(payload: unknown) => void>> = {
    message: new Set(),
    error: new Set(),
    exit: new Set(),
  };

  constructor(private readonly onPost?: (message: ScanWorkerInbound, worker: FakeWorker) => void) {}

  postMessage(value: unknown): void {
    const message = value as ScanWorkerInbound;
    this.posted.push(message);
    this.onPost?.(message, this);
  }

  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'message' | 'error' | 'exit', listener: (payload: never) => void): this {
    this.listeners[event].add(listener as unknown as (payload: unknown) => void);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.message) listener(message);
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error);
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) listener(code);
  }
}

interface Harness {
  db: DatabaseSync;
  service: ScanService;
  workers: FakeWorker[];
  events: ScanServiceEvent[];
  dbPath: string;
}

function createHarness(
  onPost?: (message: ScanWorkerInbound, worker: FakeWorker) => void,
  cancelTimeoutMs = 15000,
): Harness {
  const temp = createTempDbPath('disk-organizer-service-');
  const db = openDatabase(temp.dbPath);
  cleanups.push(() => {
    db.close();
    temp.cleanup();
  });
  const workers: FakeWorker[] = [];
  const events: ScanServiceEvent[] = [];
  const factory: ScanWorkerFactory = () => {
    const worker = new FakeWorker(onPost);
    workers.push(worker);
    return worker;
  };
  const service = new ScanService({
    db,
    dbPath: temp.dbPath,
    workerFactory: factory,
    emit: (event) => events.push(event),
    now: () => 1700000000000,
    cancelTimeoutMs,
  });
  return { db, service, workers, events, dbPath: temp.dbPath };
}

function completeScan(
  worker: FakeWorker,
  totals: { totalFiles: number; identifiedBytes: number },
): void {
  worker.emitMessage({ type: 'phase', phase: 'enumerating' });
  worker.emitMessage({
    type: 'progress',
    progress: {
      phase: 'enumerating',
      filesFound: totals.totalFiles,
      filesProcessed: 0,
      bytesProcessed: 0,
      currentPath: 'C:\\',
    },
  });
  worker.emitMessage({ type: 'phase', phase: 'indexing' });
  worker.emitMessage({
    type: 'progress',
    progress: {
      phase: 'indexing',
      filesFound: totals.totalFiles,
      filesProcessed: totals.totalFiles,
      bytesProcessed: totals.identifiedBytes,
      currentPath: 'C:\\file.bin',
    },
  });
  worker.emitMessage({
    type: 'done',
    totalFiles: totals.totalFiles,
    identifiedBytes: totals.identifiedBytes,
    skipped: [],
  });
}

function insertFileRow(
  db: DatabaseSync,
  scanId: number,
  filePath: string,
  size: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO files
        (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, 'C:', ?, ?, ?, ?, 'bin', 'program', ?, 1, 1, '', ?, ?, '', '')`,
    )
    .run(
      scanId,
      filePath,
      filePath.toLowerCase(),
      path.win32.basename(filePath),
      path.win32.basename(filePath).toLowerCase(),
      size,
      path.win32.dirname(filePath),
      path.win32.dirname(filePath).toLowerCase(),
    );
  return Number(result.lastInsertRowid);
}

describe('ScanService lifecycle', () => {
  it('commits a completed scan and makes it active', async () => {
    const { db, service, workers, events } = createHarness();
    expect(service.getState().status).toBe('idle');
    const created = service.start({
      drives: ['c:'],
      excludedPaths: ['C:\\Windows'],
      skipHiddenSystem: true,
    });
    expect(created.status).toBe('enumerating');
    expect(created.drives).toEqual(['C:']);
    expect(workers).toHaveLength(1);

    completeScan(workers[0], { totalFiles: 3, identifiedBytes: 512 });
    await service.whenIdle();

    const state = service.getState();
    expect(state.status).toBe('completed');
    expect(state.filesProcessed).toBe(3);
    const activeId = getActiveScanId(db);
    expect(activeId).toBe(state.scanId);
    const row = getScanRow(db, activeId!)!;
    expect(row.status).toBe('completed');
    expect(row.total_files).toBe(3);
    expect(row.identified_bytes).toBe(512);
    expect(row.finished_at).toBe(1700000000000);
    expect(events.some((event) => event.type === 'completed')).toBe(true);
    expect(service.isScanning()).toBe(false);

    const reopened = new ScanService({
      db,
      dbPath: '',
      workerFactory: () => {
        throw new Error('not expected');
      },
      now: () => 1700000000000,
    });
    expect(reopened.getState().status).toBe('completed');
    expect(reopened.getState().scanId).toBe(activeId);
  });

  it('keeps old data visible while rescanning and keeps it after cancel', async () => {
    const { db, service, workers } = createHarness((message, worker) => {
      if (message.type === 'cancel') worker.emitMessage({ type: 'cancelled' });
    });
    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    completeScan(workers[0], { totalFiles: 2, identifiedBytes: 100 });
    await service.whenIdle();
    const oldScanId = service.getState().scanId!;
    insertFileRow(db, oldScanId, 'C:\\old.bin', 50);

    const second = service.start({
      drives: ['C:'],
      excludedPaths: [],
      skipHiddenSystem: true,
    });
    expect(second.status).toBe('enumerating');
    expect(getActiveScanId(db)).toBe(oldScanId);
    const oldFiles = db
      .prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?')
      .get(oldScanId) as { c: number };
    expect(oldFiles.c).toBe(1);

    service.cancel();
    expect(workers[1].posted).toContainEqual({ type: 'cancel' });
    await service.whenIdle();

    expect(service.getState().status).toBe('cancelled');
    expect(getActiveScanId(db)).toBe(oldScanId);
    const cancelledRow = getScanRow(db, second.scanId!)!;
    expect(cancelledRow.status).toBe('cancelled');
    const newFiles = db
      .prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?')
      .get(second.scanId!) as { c: number };
    expect(newFiles.c).toBe(0);
    const oldFilesAfter = db
      .prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?')
      .get(oldScanId) as { c: number };
    expect(oldFilesAfter.c).toBe(1);
  });

  it('marks a failed scan without touching the active snapshot', async () => {
    const { db, service, workers, events } = createHarness();
    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    completeScan(workers[0], { totalFiles: 1, identifiedBytes: 10 });
    await service.whenIdle();
    const oldScanId = getActiveScanId(db);

    const second = service.start({
      drives: ['C:'],
      excludedPaths: [],
      skipHiddenSystem: true,
    });
    workers[1].emitError(new Error('磁盘读取失败'));
    await service.whenIdle();

    expect(service.getState().status).toBe('failed');
    expect(service.getState().error).toContain('磁盘读取失败');
    expect(workers[1].terminated).toBe(true);
    expect(getActiveScanId(db)).toBe(oldScanId);
    expect(getScanRow(db, second.scanId!)?.status).toBe('failed');
    expect(events.some((event) => event.type === 'failed')).toBe(true);
  });

  it('pauses and resumes through the worker', async () => {
    const { service, workers } = createHarness((message, worker) => {
      if (message.type === 'pause') worker.emitMessage({ type: 'paused' });
    });
    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    service.pause();
    expect(workers[0].posted).toContainEqual({ type: 'pause' });
    expect(service.getState().status).toBe('paused');
    service.resume();
    expect(workers[0].posted).toContainEqual({ type: 'resume' });
    expect(service.getState().status).toBe('enumerating');
    completeScan(workers[0], { totalFiles: 1, identifiedBytes: 1 });
    await service.whenIdle();
    expect(service.getState().status).toBe('completed');
  });

  it('force-stops a worker that ignores cancel', async () => {
    const { db, service, workers } = createHarness(undefined, 20);
    const started = service.start({
      drives: ['C:'],
      excludedPaths: [],
      skipHiddenSystem: true,
    });
    service.cancel();
    await service.whenIdle();
    expect(workers[0].terminated).toBe(true);
    expect(service.getState().status).toBe('cancelled');
    expect(getScanRow(db, started.scanId!)?.status).toBe('cancelled');
  });

  it('cleans old snapshots, hash cache, and marks older duplicate runs stale', async () => {
    const { db, service, workers } = createHarness();
    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    completeScan(workers[0], { totalFiles: 2, identifiedBytes: 100 });
    await service.whenIdle();
    const firstScanId = service.getState().scanId!;
    insertFileRow(db, firstScanId, 'C:\\old.bin', 50);
    db.prepare(
      `INSERT INTO hash_cache (path_key, size, mtime_ms, quick_hash, full_hash, updated_at)
       VALUES ('c:\\old.bin', 50, 1, 'q', 'f', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO duplicate_runs (scan_id, status, min_size, created_at)
       VALUES (?, 'completed', 1048576, 1)`,
    ).run(firstScanId);

    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    const secondScanId = service.getState().scanId!;
    insertFileRow(db, secondScanId, 'C:\\new.bin', 60);
    db.prepare(
      `INSERT INTO hash_cache (path_key, size, mtime_ms, quick_hash, full_hash, updated_at)
       VALUES ('c:\\new.bin', 60, 1, 'q', 'f', 1)`,
    ).run();
    completeScan(workers[1], { totalFiles: 1, identifiedBytes: 60 });
    await service.whenIdle();

    expect(getActiveScanId(db)).toBe(secondScanId);
    const oldFiles = db
      .prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?')
      .get(firstScanId) as { c: number };
    expect(oldFiles.c).toBe(0);
    const newFiles = db
      .prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?')
      .get(secondScanId) as { c: number };
    expect(newFiles.c).toBe(1);
    const cache = db.prepare('SELECT path_key FROM hash_cache').all() as Array<{
      path_key: string;
    }>;
    expect(cache.map((row) => row.path_key)).toEqual(['c:\\new.bin']);
    const run = db.prepare('SELECT status FROM duplicate_runs').get() as { status: string };
    expect(run.status).toBe('stale');
  });

  it('recovers interrupted scans on startup and preserves the active snapshot', () => {
    const { db, service } = createHarness();
    const goodScan = createScan(db, ['C:'], 1);
    db.prepare(
      "UPDATE scans SET status = 'completed', finished_at = 2, total_files = 1, identified_bytes = 10 WHERE id = ?",
    ).run(goodScan);
    insertFileRow(db, goodScan, 'C:\\good.bin', 10);
    setActiveScanId(db, goodScan);
    setMeta(db, 'last_scan_finished_at', '2');

    const interrupted = createScan(db, ['C:'], 3);
    insertFileRow(db, interrupted, 'C:\\partial.bin', 5);
    const orphan = createScan(db, ['D:'], 4);
    db.prepare("UPDATE scans SET status = 'completed', finished_at = 5 WHERE id = ?").run(orphan);
    insertFileRow(db, orphan, 'C:\\orphan.bin', 7);

    const result = service.recover();
    expect(result.recoveredRunning).toEqual([interrupted]);
    expect(result.activeScanId).toBe(goodScan);
    expect(getScanRow(db, interrupted)?.status).toBe('failed');
    expect(getScanRow(db, orphan)?.status).toBe('completed');
    const remaining = db.prepare('SELECT scan_id FROM files ORDER BY scan_id').all() as Array<{
      scan_id: number;
    }>;
    expect(remaining.map((row) => row.scan_id)).toEqual([goodScan]);
    expect(getActiveScanId(db)).toBe(goodScan);
  });

  it('clears an active pointer that refers to an unfinished scan', () => {
    const { db, service } = createHarness();
    const running = createScan(db, ['C:'], 10);
    setActiveScanId(db, running);
    insertFileRow(db, running, 'C:\\partial.bin', 5);
    const result = service.recover();
    expect(result.activeScanId).toBeNull();
    expect(getActiveScanId(db)).toBeNull();
    expect(getScanRow(db, running)?.status).toBe('failed');
    expect(service.getState().status).toBe('idle');
  });

  it('rejects starting while a scan is running and validates drive input', async () => {
    const { service, workers } = createHarness();
    expect(() =>
      service.start({ drives: ['not-a-drive'], excludedPaths: [], skipHiddenSystem: true }),
    ).toThrow(/选择要扫描的硬盘/);
    service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true });
    expect(() =>
      service.start({ drives: ['C:'], excludedPaths: [], skipHiddenSystem: true }),
    ).toThrow(/已有扫描/);
    service.cancel();
    workers[0].emitMessage({ type: 'cancelled' });
    await service.whenIdle();
  });
});
