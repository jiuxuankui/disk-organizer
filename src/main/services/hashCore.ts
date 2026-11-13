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

    const quickSize = Math.min(QUICK_HASH_BYTES, input.size);
    const quickBuffer = Buffer.alloc(Math.max(1, quickSize));
    const quickRead = quickSize > 0 ? await readChunk(handle, quickBuffer, 0) : 0;
    const quickHash = crypto
      .createHash('sha256')
      .update(quickBuffer.subarray(0, quickRead))
      .digest('hex');

    if (options.mode === 'quick' || input.size <= QUICK_HASH_BYTES) {
      const unchanged = await verifyUnchanged(handle, input);
      if (!unchanged) return { quickHash: null, fullHash: null, failure: 'changed' };
      return { quickHash, fullHash: input.size <= QUICK_HASH_BYTES ? quickHash : null, failure: null };
    }

    const hasher = crypto.createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
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
