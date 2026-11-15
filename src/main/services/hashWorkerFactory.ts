import os from 'node:os';
import createWorker from '../workers/hash.worker?nodeWorker';
import { HashWorkerPool } from './hashWorkerPool';
import type { HashRunner } from './hashRunner';

function workerCount(): number {
  const cores = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(6, cores - 1));
}

export function createHashRunner(): HashRunner {
  return new HashWorkerPool(() => createWorker({}), workerCount());
}
