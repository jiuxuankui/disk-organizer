import { hashFile, type HashFailure } from './hashCore';

export interface HashWorkItem {
  id: number;
  path: string;
  size: number;
  mtimeMs: number;
  mode: 'quick' | 'full';
  quickHash?: string | null;
}

export interface HashWorkResult {
  id: number;
  quickHash: string | null;
  fullHash: string | null;
  failure: HashFailure | null;
}

export interface HashRunOptions {
  signal?: AbortSignal;
  onResult?(result: HashWorkResult): void;
}

export interface HashRunner {
  run(items: HashWorkItem[], options?: HashRunOptions): Promise<HashWorkResult[]>;
  dispose(): Promise<void>;
}

export type HashRunnerFactory = () => HashRunner;

export class HashCancelledError extends Error {
  constructor() {
    super('重复查找已取消');
    this.name = 'HashCancelledError';
  }
}

export function createInlineHashRunner(): HashRunner {
  return {
    async run(items, options = {}) {
      const results: HashWorkResult[] = [];
      for (const item of items) {
        if (options.signal?.aborted) throw new HashCancelledError();
        const output = await hashFile(item, { mode: item.mode });
        const result: HashWorkResult = { id: item.id, ...output };
        results.push(result);
        options.onResult?.(result);
      }
      return results;
    },
    async dispose() {
      // Nothing to release for the inline runner.
    },
  };
}
