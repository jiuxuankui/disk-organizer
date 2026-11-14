export const VIDEO_EXTENSIONS = [
  'mp4',
  'mkv',
  'mov',
  'avi',
  'wmv',
  'flv',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  'ts',
  'mts',
  'm2ts',
] as const;

export type VideoQuality = 'quality' | 'balanced' | 'smaller';

export const VIDEO_QUALITIES: Record<VideoQuality, { label: string; crf: number }> = {
  quality: { label: '画质优先（推荐）', crf: 18 },
  balanced: { label: '画质与体积均衡', crf: 22 },
  smaller: { label: '更小体积（画质损失较多）', crf: 26 },
};

export interface VideoRequest {
  paths: string[];
  outputDir: string;
  quality: VideoQuality;
}

export interface VideoResult {
  path: string;
  outputPath: string | null;
  status: 'completed' | 'skipped' | 'failed' | 'cancelled';
  inputBytes: number;
  outputBytes: number;
  message: string;
}

export interface VideoState {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled';
  total: number;
  processed: number;
  currentPath: string;
  percent: number;
  results: VideoResult[];
}
