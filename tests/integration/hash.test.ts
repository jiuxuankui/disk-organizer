import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashFile } from '../../src/main/services/hashCore';
import {
  createInlineHashRunner,
  HashCancelledError,
} from '../../src/main/services/hashRunner';
import { openDatabase } from '../../src/main/db/connection';
import {
  getHashCacheRows,
  upsertFullHash,
  upsertQuickHash,
} from '../../src/main/db/hashCacheRepo';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-hash-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function input(filePath: string): { path: string; size: number; mtimeMs: number } {
  const stats = fs.statSync(filePath, { bigint: true });
  return { path: filePath, size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };
}

describe('file hashing', () => {
  it('groups identical content and separates same-size different content', async () => {
    const dir = tempDir();
    const first = path.join(dir, 'first.bin');
    const second = path.join(dir, 'second.bin');
    const different = path.join(dir, 'different.bin');
    const content = crypto.randomBytes(150 * 1024);
    const other = crypto.randomBytes(150 * 1024);
    fs.writeFileSync(first, content);
    fs.writeFileSync(second, content);
    fs.writeFileSync(different, other);

    const quickFirst = await hashFile(input(first), { mode: 'quick' });
    const quickSecond = await hashFile(input(second), { mode: 'quick' });
    const quickDifferent = await hashFile(input(different), { mode: 'quick' });
    expect(quickFirst.failure).toBeNull();
    expect(quickFirst.quickHash).toBe(quickSecond.quickHash);
    expect(quickFirst.quickHash).not.toBe(quickDifferent.quickHash);

    const fullFirst = await hashFile(input(first), { mode: 'full' });
    const fullSecond = await hashFile(input(second), { mode: 'full' });
    const fullDifferent = await hashFile(input(different), { mode: 'full' });
    expect(fullFirst.fullHash).toBe(fullSecond.fullHash);
    expect(fullFirst.fullHash).not.toBe(fullDifferent.fullHash);
    expect(fullFirst.fullHash).toBe(
      crypto.createHash('sha256').update(content).digest('hex'),
    );
  });

  it('uses full content for files smaller than the quick window', async () => {
    const dir = tempDir();
    const small = path.join(dir, 'small.txt');
    fs.writeFileSync(small, 'small content');
    const result = await hashFile(input(small), { mode: 'full' });
    expect(result.failure).toBeNull();
    expect(result.fullHash).toBe(result.quickHash);
    expect(result.fullHash).toBe(
      crypto.createHash('sha256').update('small content').digest('hex'),
    );
  });

  it('reports changed and missing files instead of returning stale hashes', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'changed.bin');
    fs.writeFileSync(file, Buffer.alloc(4096, 1));
    const stale = input(file);
    stale.mtimeMs += 12345;
    expect(await hashFile(stale, { mode: 'quick' })).toMatchObject({
      quickHash: null,
      failure: 'changed',
    });
    expect(await hashFile({ ...input(file), size: 1 }, { mode: 'quick' })).toMatchObject({
      failure: 'changed',
    });

    const missing = await hashFile(
      { path: path.join(dir, 'missing.bin'), size: 10, mtimeMs: 1 },
      { mode: 'quick' },
    );
    expect(missing.failure).toBe('missing');
  });

  it('stores and reads quick and full hashes in the cache table', () => {
    const temp = createTempDbPath();
    cleanups.push(temp.cleanup);
    const db = openDatabase(temp.dbPath);
    try {
      upsertQuickHash(db, 'c:\\a.bin', 100, 10, 'quick-a', 1000);
      let rows = getHashCacheRows(db, ['c:\\a.bin']);
      expect(rows.get('c:\\a.bin')).toMatchObject({
        quick_hash: 'quick-a',
        full_hash: null,
        size: 100,
        mtime_ms: 10,
      });

      upsertFullHash(db, 'c:\\a.bin', 100, 10, 'quick-a', 'full-a', 1001);
      rows = getHashCacheRows(db, ['c:\\a.bin']);
      expect(rows.get('c:\\a.bin')).toMatchObject({
        quick_hash: 'quick-a',
        full_hash: 'full-a',
      });

      upsertQuickHash(db, 'c:\\a.bin', 200, 20, 'quick-b', 1002);
      rows = getHashCacheRows(db, ['c:\\a.bin']);
      expect(rows.get('c:\\a.bin')).toMatchObject({
        quick_hash: 'quick-b',
        full_hash: null,
        size: 200,
      });

      const many = Array.from({ length: 501 }, (_, index) => `c:\\file-${index}.bin`);
      expect(getHashCacheRows(db, many).size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('stops an inline run when the signal is aborted', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'abort.bin');
    fs.writeFileSync(file, Buffer.alloc(1024, 3));
    const controller = new AbortController();
    controller.abort();
    const runner = createInlineHashRunner();
    await expect(
      runner.run([{ id: 1, ...input(file), mode: 'quick' }], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(HashCancelledError);
  });
});
