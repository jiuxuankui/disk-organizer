import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { IndexSyncResult } from '@shared/types';
import { listIndexFileRefs, pruneMissingFiles, type IndexFileRef } from '../db/filesRepo';
import { getActiveScanId } from '../db/scansRepo';

export interface IndexSyncDrives {
  refresh(): Array<{ letter: string; ready: boolean }>;
}

export interface IndexSyncServiceDeps {
  db: DatabaseSync;
  drives: IndexSyncDrives;
  isBusy?: () => boolean;
  concurrency?: number;
  batchSize?: number;
  maxChecksPerRun?: number;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_MAX_CHECKS = 50000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function statMissing(filePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filePath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

async function collectMissing(refs: IndexFileRef[], concurrency: number): Promise<IndexFileRef[]> {
  const missing: IndexFileRef[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, refs.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= refs.length) return;
        if (await statMissing(refs[index].path)) missing.push(refs[index]);
      }
    },
  );
  await Promise.all(workers);
  return missing;
}

export class IndexSyncService {
  private readonly db: DatabaseSync;
  private readonly drives: IndexSyncDrives;
  private readonly isBusy: () => boolean;
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly maxChecksPerRun: number;
  private syncing = false;
  private scanId: number | null = null;
  private cursor = 0;

  constructor(deps: IndexSyncServiceDeps) {
    this.db = deps.db;
    this.drives = deps.drives;
    this.isBusy = deps.isBusy ?? (() => false);
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxChecksPerRun = deps.maxChecksPerRun ?? DEFAULT_MAX_CHECKS;
  }

  async sync(): Promise<IndexSyncResult> {
    if (this.syncing || this.isBusy()) return { removed: 0, checked: 0, skipped: true };
    const scanId = getActiveScanId(this.db);
    if (scanId === null) return { removed: 0, checked: 0, skipped: true };
    if (this.scanId !== scanId) {
      this.scanId = scanId;
      this.cursor = 0;
    }

    this.syncing = true;
    try {
      const online = new Set(
        this.drives
          .refresh()
          .filter((drive) => drive.ready)
          .map((drive) => drive.letter),
      );
      const missing: IndexFileRef[] = [];
      let examined = 0;
      let checked = 0;
      while (examined < this.maxChecksPerRun) {
        const rows = listIndexFileRefs(this.db, scanId, this.cursor, this.batchSize);
        if (rows.length === 0) {
          this.cursor = 0;
          break;
        }
        this.cursor = rows[rows.length - 1].id;
        examined += rows.length;
        const refs = rows.filter((ref) => online.has(ref.drive));
        checked += refs.length;
        if (refs.length > 0) missing.push(...(await collectMissing(refs, this.concurrency)));
        if (rows.length < this.batchSize) {
          this.cursor = 0;
          break;
        }
        if (getActiveScanId(this.db) !== scanId || this.isBusy()) {
          return { removed: 0, checked, skipped: true };
        }
        await yieldToEventLoop();
      }
      if (getActiveScanId(this.db) !== scanId || this.isBusy()) {
        return { removed: 0, checked, skipped: true };
      }
      if (missing.length > 0) pruneMissingFiles(this.db, scanId, missing);
      return { removed: missing.length, checked, skipped: false };
    } finally {
      this.syncing = false;
    }
  }
}
