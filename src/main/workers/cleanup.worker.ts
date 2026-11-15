import { parentPort, workerData } from 'node:worker_threads';
import { closeDatabaseQuietly, openDatabase } from '../db/connection';
import { cleanupScanSnapshots } from '../services/cleanupService';
import type { CleanupWorkerData, CleanupWorkerOutbound } from './cleanupProtocols';

if (!parentPort) {
  throw new Error('清理线程缺少父线程通信端口');
}

const port = parentPort;
const data = workerData as CleanupWorkerData;

function post(message: CleanupWorkerOutbound): void {
  port.postMessage(message);
}

async function main(): Promise<void> {
  let db;
  try {
    db = openDatabase(data.dbPath, { checkIntegrity: false });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    const result = await cleanupScanSnapshots(db, data.activeScanId);
    closeDatabaseQuietly(db);
    post({ type: 'done', ...result });
  } catch (error) {
    closeDatabaseQuietly(db);
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

void main();
