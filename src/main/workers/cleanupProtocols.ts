export interface CleanupWorkerData {
  dbPath: string;
  activeScanId: number | null;
}

export type CleanupWorkerOutbound =
  | { type: 'done'; files: number; staging: number; hashCache: number }
  | { type: 'error'; message: string };
