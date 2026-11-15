import type { DatabaseSync } from 'node:sqlite';
import { listOtherScanIds, listScanIds, pruneHashCache } from '../db/scansRepo';

export interface CleanupOptions {
  batchSize?: number;
  yieldToLoop?: () => Promise<void>;
}

export interface CleanupResult {
  files: number;
  staging: number;
  hashCache: number;
}

function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function cleanupScanSnapshots(
  db: DatabaseSync,
  activeScanId: number | null,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 2000));
  const yieldToLoop = options.yieldToLoop ?? defaultYield;
  const deleteFiles = db.prepare(
    'DELETE FROM files WHERE id IN (SELECT id FROM files WHERE scan_id = ? LIMIT ?)',
  );
  const deleteStaging = db.prepare(
    `DELETE FROM scan_staging
     WHERE scan_id = ?
       AND path_key IN (SELECT path_key FROM scan_staging WHERE scan_id = ? LIMIT ?)`,
  );

  let files = 0;
  let staging = 0;

  async function purgeScan(scanId: number): Promise<void> {
    for (;;) {
      const result = deleteFiles.run(scanId, batchSize);
      const changes = Number(result.changes);
      if (changes === 0) break;
      files += changes;
      await yieldToLoop();
    }
    for (;;) {
      const result = deleteStaging.run(scanId, scanId, batchSize);
      const changes = Number(result.changes);
      if (changes === 0) break;
      staging += changes;
      await yieldToLoop();
    }
  }

  const staleScanIds =
    activeScanId === null ? listScanIds(db) : listOtherScanIds(db, activeScanId);
  for (const scanId of staleScanIds) {
    await purgeScan(scanId);
  }

  if (activeScanId === null) {
    const result = db.prepare('DELETE FROM hash_cache').run();
    return { files, staging, hashCache: Number(result.changes) };
  }

  // 成功扫描后临时表可能仍有未处理完的行（例如旧版本遗留），一并清掉。
  for (;;) {
    const result = deleteStaging.run(activeScanId, activeScanId, batchSize);
    const changes = Number(result.changes);
    if (changes === 0) break;
    staging += changes;
    await yieldToLoop();
  }

  return { files, staging, hashCache: pruneHashCache(db, activeScanId) };
}
