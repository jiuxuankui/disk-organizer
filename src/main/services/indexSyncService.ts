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
}

const DEFAULT_CONCURRENCY = 32;

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
  private syncing = false;

  constructor(deps: IndexSyncServiceDeps) {
    this.db = deps.db;
    this.drives = deps.drives;
    this.isBusy = deps.isBusy ?? (() => false);
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  async sync(): Promise<IndexSyncResult> {
    if (this.syncing || this.isBusy()) return { removed: 0, checked: 0, skipped: true };
    const scanId = getActiveScanId(this.db);
    if (scanId === null) return { removed: 0, checked: 0, skipped: true };

    this.syncing = true;
    try {
      const online = new Set(
        this.drives
          .refresh()
          .filter((drive) => drive.ready)
          .map((drive) => drive.letter),
      );
      const refs = listIndexFileRefs(this.db, scanId).filter((ref) => online.has(ref.drive));
      const missing = await collectMissing(refs, this.concurrency);
      if (missing.length === 0) return { removed: 0, checked: refs.length, skipped: false };
      if (getActiveScanId(this.db) !== scanId || this.isBusy()) {
        return { removed: 0, checked: refs.length, skipped: true };
      }
      pruneMissingFiles(this.db, scanId, missing);
      return { removed: missing.length, checked: refs.length, skipped: false };
    } finally {
      this.syncing = false;
    }
  }
}
