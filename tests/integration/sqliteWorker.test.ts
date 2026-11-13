import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort cleanup of temp test data.
    }
  }
});

function waitForMessage(worker: Worker, predicate: (message: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error('worker message timeout'));
    }, 60000);
    function onMessage(message: unknown) {
      if (!predicate(message)) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      resolve(message);
    }
    worker.on('message', onMessage);
    worker.on('error', (error) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      reject(error);
    });
  });
}

describe('SQLite worker + backup', () => {
  it('writes 200k rows from a worker, reads from the main thread, and backs up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-sqlite-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'index.db');
    const backupPath = path.join(dir, 'index-backup.db');

    const worker = new Worker(new URL('../fixtures/sqlite-writer.mjs', import.meta.url), {
      workerData: { dbPath, total: 200000, batch: 10000 },
    });

    await waitForMessage(worker, (message) => {
      return typeof message === 'object' && message !== null && 'type' in message
        ? (message as { type: string }).type === 'halfway'
        : false;
    });

    const mainDb = new DatabaseSync(dbPath);
    mainDb.exec('PRAGMA busy_timeout = 5000;');
    const halfwayCount = mainDb.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
    expect(halfwayCount.c).toBe(100000);
    const journal = mainDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(journal.journal_mode.toLowerCase()).toBe('wal');

    worker.postMessage('continue');
    const done = (await waitForMessage(worker, (message) => {
      return typeof message === 'object' && message !== null && 'type' in message
        ? (message as { type: string }).type === 'done'
        : false;
    })) as { count: number };
    expect(done.count).toBe(200000);

    const started = performance.now();
    const top = mainDb
      .prepare('SELECT name, size FROM files ORDER BY size DESC LIMIT 10')
      .all() as Array<{ name: string; size: number }>;
    const elapsed = performance.now() - started;
    expect(top).toHaveLength(10);
    expect(top[0].size).toBeGreaterThanOrEqual(top[9].size);
    expect(elapsed).toBeLessThan(300);

    const pages = await backup(mainDb, backupPath);
    expect(pages).toBeGreaterThan(0);
    mainDb.close();
    await worker.terminate();

    const restored = new DatabaseSync(backupPath);
    const restoredCount = restored.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
    expect(restoredCount.c).toBe(200000);
    const quickCheck = restored.prepare('PRAGMA quick_check').get() as { quick_check: string };
    expect(quickCheck.quick_check).toBe('ok');
    restored.close();
  });
});
