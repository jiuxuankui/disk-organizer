import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import { VIDEO_QUALITIES, type VideoQuality } from '@shared/video';

const streamSchema = z.object({
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  color_transfer: z.string().optional(),
  side_data_list: z
    .array(
      z.object({
        rotation: z.number().optional(),
        side_data_type: z.string().optional(),
      }),
    )
    .optional(),
});
const probeSchema = z.object({
  streams: z.array(streamSchema),
  format: z.object({ duration: z.string().optional() }),
});
export type VideoProbe = z.infer<typeof probeSchema>;

export const LOCAL_MEDIA_ARGS = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,matroska,avi,asf,flv,mpeg,mpegts',
];

// Measured on 1080p: medium is ~2.3x faster than slow at near-identical SSIM.
export const VIDEO_PRESET = 'medium';

export function runVideoTool(
  executable: string,
  args: string[],
  signal: AbortSignal,
  onLine?: (line: string) => void,
  lowPriority = false,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (lowPriority && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Priority is a courtesy for desktop responsiveness; encoding proceeds without it.
      }
    }
    let output = '';
    let pending = '';
    let errors = '';
    let spawnError: Error | null = null;
    const stop = (): void => {
      child.kill();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-2 * 1024 * 1024);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-8192);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new Error('已取消压缩'));
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(errors.trim() || `视频工具退出，代码 ${code}`));
      else resolve(output);
    });
  });
}

export async function probeVideo(
  executable: string,
  input: string,
  signal: AbortSignal,
): Promise<VideoProbe> {
  const json = await runVideoTool(
    executable,
    ['-v', 'error', ...LOCAL_MEDIA_ARGS, '-show_streams', '-show_format', '-of', 'json', input],
    signal,
  );
  return probeSchema.parse(JSON.parse(json));
}

export function inspectVideo(probe: VideoProbe): { duration: number; pixelFormat: string } {
  const videos = probe.streams.filter((stream) => stream.codec_type === 'video');
  const video = videos[0];
  const duration = Number(probe.format.duration);
  if (
    videos.length !== 1 ||
    !video?.width ||
    !video.height ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error('只支持包含一个有效视频画面且时长可读的本地视频');
  }
  if (
    probe.streams.some(
      (stream) => !['video', 'audio', 'subtitle', 'attachment'].includes(stream.codec_type),
    )
  ) {
    throw new Error('包含无法安全保留的数据轨道，请保留原文件');
  }
  if (
    ['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '') ||
    video.side_data_list?.some(
      (item) =>
        Boolean(item.rotation) ||
        /DOVI|HDR|Mastering|Content light/i.test(item.side_data_type ?? ''),
    )
  ) {
    throw new Error('暂不压缩 HDR、杜比视界或旋转视频，避免丢失色彩或方向信息');
  }
  if (
    !['yuv420p', 'yuv420p10le', 'yuv422p', 'yuv422p10le', 'yuv444p', 'yuv444p10le'].includes(
      video.pix_fmt ?? '',
    )
  ) {
    throw new Error('暂不支持该视频的色彩格式，原文件保持不变');
  }
  return { duration, pixelFormat: video.pix_fmt! };
}

export function videoEncodeArgs(
  input: string,
  output: string,
  quality: VideoQuality,
  pixelFormat: string,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    ...LOCAL_MEDIA_ARGS,
    '-noautorotate',
    '-i',
    input,
    '-map',
    '0',
    '-map_metadata',
    '0',
    '-map_chapters',
    '0',
    '-c',
    'copy',
    '-c:v:0',
    'libx265',
    '-preset',
    VIDEO_PRESET,
    '-crf',
    String(VIDEO_QUALITIES[quality].crf),
    '-pix_fmt',
    pixelFormat,
    '-x265-params',
    'log-level=error',
    '-fps_mode',
    'passthrough',
    '-stats_period',
    '0.5',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'matroska',
    output,
  ];
}

export interface EncodeProgress {
  percent: number;
  fps: number | null;
  speed: number | null;
}

export function applyProgressLine(
  line: string,
  duration: number,
  progress: EncodeProgress,
): boolean {
  const [key, raw] = line.trim().split('=', 2);
  if (raw === undefined) return false;
  if (key === 'out_time_us' && /^\d+$/.test(raw) && duration > 0) {
    progress.percent = Math.min(
      99,
      Math.max(progress.percent, Math.floor((Number(raw) / 1_000_000 / duration) * 100)),
    );
    return true;
  }
  if (key === 'fps') {
    const fps = Number(raw);
    if (!Number.isFinite(fps) || fps <= 0) return false;
    progress.fps = fps;
    return true;
  }
  if (key === 'speed') {
    const speed = /^([\d.]+)x$/.exec(raw);
    if (!speed || !(Number(speed[1]) > 0)) return false;
    progress.speed = Number(speed[1]);
    return true;
  }
  return false;
}

export function estimateRemainingSeconds(percent: number, elapsedMs: number): number | null {
  if (percent < 1 || elapsedMs <= 0) return null;
  return Math.max(0, Math.round(((elapsedMs / 1000) * (100 - percent)) / percent));
}

export function verifyVideoOutput(before: VideoProbe, after: VideoProbe): void {
  const source = before.streams.find((stream) => stream.codec_type === 'video')!;
  const result = after.streams.find((stream) => stream.codec_type === 'video');
  const sameStreams =
    before.streams.length === after.streams.length &&
    before.streams.every((stream, index) => {
      const next = after.streams[index];
      return (
        next?.codec_type === stream.codec_type &&
        (stream.codec_type === 'video' || next.codec_name === stream.codec_name)
      );
    });
  const sourceDuration = Number(before.format.duration);
  const duration = Number(after.format.duration);
  if (
    !sameStreams ||
    result?.codec_name !== 'hevc' ||
    result.width !== source.width ||
    result.height !== source.height ||
    result.pix_fmt !== source.pix_fmt ||
    !Number.isFinite(duration) ||
    Math.abs(duration - sourceDuration) > Math.max(0.25, sourceDuration * 0.001)
  ) {
    throw new Error('输出校验未通过，未保留不完整的压缩文件，原文件不变');
  }
}
