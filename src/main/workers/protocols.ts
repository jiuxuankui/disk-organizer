import type { SkippedSummary } from '@shared/types';

export interface ScanCoreProgress {
  phase: 'enumerating' | 'indexing';
  filesFound: number;
  filesProcessed: number;
  bytesProcessed: number;
  currentPath: string;
}

export interface ScanWorkerData {
  scanId: number;
  dbPath: string;
  drives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
  batchSize: number;
}

export type ScanWorkerInbound =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' };

export type ScanWorkerOutbound =
  | { type: 'phase'; phase: 'enumerating' | 'indexing' }
  | { type: 'progress'; progress: ScanCoreProgress }
  | { type: 'paused' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      totalFiles: number;
      identifiedBytes: number;
      skipped: SkippedSummary[];
    };
