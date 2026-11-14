export type ArchiveFormat = 'zip' | 'tar.gz';

export interface ArchiveRequest {
  fileIds: number[];
  outputDir: string;
  name: string;
  format: ArchiveFormat;
}

export interface ArchiveState {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  percent: number;
  outputPath: string | null;
  outputBytes: number;
  message: string;
}
