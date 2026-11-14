import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { QUICK_HASH_BYTES } from '@shared/constants';
import { toExtendedPath } from './filesystem';

export type HashFailure = 'missing' | 'permission' | 'changed' | 'error';

export interface HashResult {
  quickHash: string | null;
  fullHash: string | null;
  failure: HashFailure | null;
}

export interface HashInput {
  path: string;
  size: number;
  mtimeMs: number;
  quickHash?: string | null;
}

export const QUICK_HASH_PREFIX = 'q2:';
const FULL_HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export function isCurrentQuickHash(hash: string | null | undefined, size: number): boolean {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  return size <= QUICK_HASH_BYTES || hash.startsWith(QUICK_HASH_PREFIX);
}

export interface HashOptions {
  mode: 'quick' | 'full';
}

function failureFromError(error: unknown): HashFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'permission';
  return 'error';
}

async function readChunk(
  handle: fs.FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
  return bytesRead;
}

function quickHashLayout(size: number): Array<{ position: number; length: number }> {
  if (size <= 0) return [];
  if (size <= QUICK_HASH_BYTES) return [{ position: 0, length: size }];
  const span = Math.min(
    QUICK_HASH_BYTES,
    Math.max(1, Math.floor(size / 3)),
  );
  const positions = new Set([
    0,
    Math.max(0, Math.floor(size / 2) - Math.floor(span / 2)),
    Math.max(0, size - span),
  ]);
  return [...positions]
    .sort((a, b) => a - b)
    .map((position) => ({ position, length: Math.min(span, size - position) }));
}

async function computeQuickHash(handle: fs.FileHandle, size: number): Promise<string> {
  const hasher = crypto.createHash('sha256');
  const layout = quickHashLayout(size);
  if (layout.length === 0) return hasher.digest('hex');
  const buffer = Buffer.alloc(Math.max(...layout.map((entry) => entry.length)));
  for (const entry of layout) {
    const bytesRead = await readChunk(handle, buffer.subarray(0, entry.length), entry.position);
    hasher.update(buffer.subarray(0, bytesRead));
  }
  const digest = hasher.digest('hex');
  return size <= QUICK_HASH_BYTES ? digest : `${QUICK_HASH_PREFIX}${digest}`;
}

export async function hashFile(input: HashInput, options: HashOptions): Promise<HashResult> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(toExtendedPath(input.path), 'r');
    const before = await handle.stat({ bigint: true });
    if (
      Number(before.size) !== input.size ||
      Number(before.mtimeMs) !== input.mtimeMs ||
      !before.isFile()
    ) {
      return { quickHash: null, fullHash: null, failure: 'changed' };
    }

    const quickHash =
      options.mode === 'full' && isCurrentQuickHash(input.quickHash, input.size)
        ? input.quickHash!
        : await computeQuickHash(handle, input.size);

    if (options.mode === 'quick' || input.size <= QUICK_HASH_BYTES) {
      const unchanged = await verifyUnchanged(handle, input);
      if (!unchanged) return { quickHash: null, fullHash: null, failure: 'changed' };
      return { quickHash, fullHash: input.size <= QUICK_HASH_BYTES ? quickHash : null, failure: null };
    }

    const hasher = crypto.createHash('sha256');
    const chunk = Buffer.alloc(FULL_HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = await readChunk(handle, chunk, position);
      if (bytesRead === 0) break;
      hasher.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const unchanged = await verifyUnchanged(handle, input);
    if (!unchanged) return { quickHash: null, fullHash: null, failure: 'changed' };
    return { quickHash, fullHash: hasher.digest('hex'), failure: null };
  } catch (error) {
    return { quickHash: null, fullHash: null, failure: failureFromError(error) };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Closing a failed handle is best effort.
      }
    }
  }
}

async function verifyUnchanged(handle: fs.FileHandle, input: HashInput): Promise<boolean> {
  const after = await handle.stat({ bigint: true });
  return Number(after.size) === input.size && Number(after.mtimeMs) === input.mtimeMs;
}
