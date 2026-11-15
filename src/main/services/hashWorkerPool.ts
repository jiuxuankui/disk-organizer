import type {
  HashRunOptions,
  HashRunner,
  HashWorkItem,
  HashWorkResult,
} from './hashRunner';
import { HashCancelledError } from './hashRunner';

export interface HashWorkerHandle {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | number | void;
}

export type HashWorkerFactory = () => HashWorkerHandle;

interface WorkerSlot {
  worker: HashWorkerHandle;
  currentId: number | null;
  exited: boolean;
}

type WorkerMessage =
  | { type: 'done'; id: number; result: Omit<HashWorkResult, 'id'> }
  | { type: 'failed'; id: number; message: string };

export class HashWorkerPool implements HashRunner {
  private readonly factory: HashWorkerFactory;
  private readonly concurrency: number;

  constructor(factory: HashWorkerFactory, concurrency = 2) {
    this.factory = factory;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
  }

  async run(items: HashWorkItem[], options: HashRunOptions = {}): Promise<HashWorkResult[]> {
    if (items.length === 0) return [];
    const workerCount = Math.min(this.concurrency, items.length);
    const results: HashWorkResult[] = [];
    const slots: WorkerSlot[] = [];
    let nextIndex = 0;
    let settled = false;

    return await new Promise<HashWorkResult[]>((resolve, reject) => {
      const cleanup = async (): Promise<void> => {
        await Promise.all(
          slots.map(async (slot) => {
            if (slot.exited) return;
            slot.exited = true;
            try {
              await slot.worker.terminate();
            } catch {
              // Worker may already be gone.
            }
          }),
        );
      };

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        void cleanup().finally(() => reject(error));
      };

      const finishIfDone = (): void => {
        if (settled) return;
        if (nextIndex < items.length) return;
        if (slots.some((slot) => slot.currentId !== null)) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        void cleanup().finally(() => resolve(results));
      };

      const dispatch = (slot: WorkerSlot): void => {
        if (settled) return;
        if (nextIndex >= items.length) {
          finishIfDone();
          return;
        }
        const item = items[nextIndex];
        nextIndex += 1;
        slot.currentId = item.id;
        slot.worker.postMessage({ type: 'hash', item });
      };

      const onAbort = (): void => {
        fail(new HashCancelledError());
      };

      if (options.signal?.aborted) {
        fail(new HashCancelledError());
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      for (let i = 0; i < workerCount; i += 1) {
        let worker: HashWorkerHandle;
        try {
          worker = this.factory();
        } catch (error) {
          fail(error);
          return;
        }
        const slot: WorkerSlot = { worker, currentId: null, exited: false };
        slots.push(slot);

        worker.on('message', (raw) => {
          if (settled) return;
          const message = raw as WorkerMessage;
          if (message.type === 'failed') {
            fail(new Error(message.message));
            return;
          }
          if (message.type !== 'done' || slot.currentId !== message.id) return;
          const result: HashWorkResult = { id: message.id, ...message.result };
          results.push(result);
          options.onResult?.(result);
          slot.currentId = null;
          dispatch(slot);
          finishIfDone();
        });

        worker.on('error', (error) => {
          fail(error);
        });

        worker.on('exit', (code) => {
          slot.exited = true;
          if (!settled) {
            fail(new Error(`哈希进程意外退出（代码 ${code}）`));
          }
        });
      }

      for (const slot of slots) dispatch(slot);
    });
  }

  async dispose(): Promise<void> {
    // Workers are created per run and terminated when the run finishes.
  }
}
