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

export type VideoPhase = 'idle' | 'probing' | 'encoding' | 'verifying' | 'saving';

export const VIDEO_PHASE_LABELS: Record<VideoPhase, string> = {
  idle: '等待中',
  probing: '正在读取视频信息',
  encoding: '正在编码',
  verifying: '正在校验输出',
  saving: '正在保存',
};

export interface VideoState {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled';
  total: number;
  processed: number;
  currentPath: string;
  percent: number;
  phase: VideoPhase;
  fps: number | null;
  speed: number | null;
  etaSeconds: number | null;
  startedAt: number | null;
  fileStartedAt: number | null;
  results: VideoResult[];
}

export function overallVideoPercent(state: VideoState): number {
  if (state.total <= 0) return 0;
  const current = state.status === 'running' || state.status === 'cancelling' ? state.percent : 0;
  return Math.min(100, Math.floor(((state.processed + current / 100) / state.total) * 100));
}
