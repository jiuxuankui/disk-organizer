import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase, closeDatabaseQuietly } from '../db/connection';
import {
  runScanCore,
  ScanCancelledError,
  type ScanControl,
} from './scanCore';
import type {
  ScanWorkerData,
  ScanWorkerInbound,
  ScanWorkerOutbound,
} from './protocols';

if (!parentPort) {
  throw new Error('扫描进程缺少父线程通信端口');
}

const port = parentPort;
const data = workerData as ScanWorkerData;
const control: ScanControl = { paused: false, cancelled: false };
let resumePaused: (() => void) | null = null;

function post(message: ScanWorkerOutbound): void {
  port.postMessage(message);
}

port.on('message', (message: ScanWorkerInbound) => {
  if (message.type === 'pause') {
    control.paused = true;
    return;
  }
  if (message.type === 'resume') {
    control.paused = false;
    const release = resumePaused;
    resumePaused = null;
    release?.();
    return;
  }
  if (message.type === 'cancel') {
    control.cancelled = true;
    control.paused = false;
    const release = resumePaused;
    resumePaused = null;
    release?.();
  }
});

async function main(): Promise<void> {
  let db;
  try {
    db = openDatabase(data.dbPath, { checkIntegrity: false });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    const result = await runScanCore(db, data, control, {
      onPhase(phase) {
        post({ type: 'phase', phase });
      },
      onProgress(progress) {
        post({ type: 'progress', progress });
      },
      onPaused() {
        post({ type: 'paused' });
        return new Promise<void>((resolve) => {
          if (!control.paused) {
            resolve();
            return;
          }
          resumePaused = resolve;
        });
      },
    });
    closeDatabaseQuietly(db);
    post({ type: 'done', ...result });
  } catch (error) {
    closeDatabaseQuietly(db);
    if (error instanceof ScanCancelledError || control.cancelled) {
      post({ type: 'cancelled' });
      return;
    }
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

void main();
