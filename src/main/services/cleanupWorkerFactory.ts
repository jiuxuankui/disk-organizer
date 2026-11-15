import createWorker from '../workers/cleanup.worker?nodeWorker';
import type { CleanupWorkerData } from '../workers/cleanupProtocols';

export function createCleanupWorker(data: CleanupWorkerData): ReturnType<typeof createWorker> {
  return createWorker({ workerData: data });
}
