import createWorker from '../workers/scanner.worker?nodeWorker';
import type { ScanWorkerData } from '../workers/protocols';
import type { ScanWorkerFactory } from './scanService';

export const createScanWorker: ScanWorkerFactory = (data: ScanWorkerData) => {
  return createWorker({ workerData: data });
};
