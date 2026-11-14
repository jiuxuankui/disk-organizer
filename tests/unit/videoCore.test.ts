import { describe, expect, it } from 'vitest';
import {
  VIDEO_PRESET,
  applyProgressLine,
  estimateRemainingSeconds,
  inspectVideo,
  verifyVideoOutput,
  videoEncodeArgs,
  type VideoProbe,
} from '../../src/main/services/videoCore';
import { videoStartSchema } from '../../src/main/ipc/schemas';
import { VIDEO_QUALITIES, overallVideoPercent, type VideoState } from '../../src/shared/video';
import fs from 'node:fs';
import path from 'node:path';

const probe: VideoProbe = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p',
      avg_frame_rate: '30/1',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '10.000' },
};

describe('video encoding safety and quality', () => {
  it('keeps dimensions, frame timing, bit depth and other streams without a shell command', () => {
    const args = videoEncodeArgs(
      'C:\\video & friends\\a.mp4',
      'C:\\out\\a.mkv',
      'quality',
      'yuv420p10le',
    );
    expect(args[args.indexOf('-i') + 1]).toBe('C:\\video & friends\\a.mp4');
    expect(args[args.indexOf('-crf') + 1]).toBe('18');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args[args.indexOf('-map') + 1]).toBe('0');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p10le');
    expect(args).toContain('-n');
    expect(args).not.toContain('-y');
    expect(args).not.toContain('-r');
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-b:v');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(VIDEO_QUALITIES.quality.crf).toBeLessThan(VIDEO_QUALITIES.smaller.crf);
  });

  it('uses all cores with a faster preset while keeping quality settings intact', () => {
    const args = videoEncodeArgs('C:\\a.mp4', 'C:\\out\\a.mkv', 'quality', 'yuv420p');
    expect(args[args.indexOf('-preset') + 1]).toBe(VIDEO_PRESET);
    expect(VIDEO_PRESET).toBe('medium');
    const params = args[args.indexOf('-x265-params') + 1];
    expect(params).toBe('log-level=error');
    expect(params).not.toMatch(/pools|frame-threads/);
    expect(args[args.indexOf('-stats_period') + 1]).toBe('0.5');
    expect(args[args.indexOf('-crf') + 1]).toBe(String(VIDEO_QUALITIES.quality.crf));
  });

  it('parses chunked process lines only when they contain usable progress', () => {
    const progress = { percent: 0, fps: null as number | null, speed: null as number | null };
    expect(applyProgressLine('out_time_us=5000000', 10, progress)).toBe(true);
    expect(progress.percent).toBe(50);
    expect(applyProgressLine('out_time_us=10000000', 10, progress)).toBe(true);
    expect(progress.percent).toBe(99);
    expect(applyProgressLine('out_time_us=2000000', 10, progress)).toBe(true);
    expect(progress.percent).toBe(99);
    expect(applyProgressLine('fps=57.1', 10, progress)).toBe(true);
    expect(progress.fps).toBe(57.1);
    expect(applyProgressLine('speed=2.15x', 10, progress)).toBe(true);
    expect(progress.speed).toBe(2.15);
    expect(applyProgressLine('out_time_us=N/A', 10, progress)).toBe(false);
    expect(applyProgressLine('speed=N/A', 10, progress)).toBe(false);
    expect(applyProgressLine('fps=0', 10, progress)).toBe(false);
    expect(applyProgressLine('progress=end', 10, progress)).toBe(false);
    expect(applyProgressLine('out_time_us=100', 0, progress)).toBe(false);
    expect(progress).toMatchObject({ percent: 99, fps: 57.1, speed: 2.15 });
  });

  it('estimates remaining time only once progress is measurable', () => {
    expect(estimateRemainingSeconds(0, 5000)).toBeNull();
    expect(estimateRemainingSeconds(50, 0)).toBeNull();
    expect(estimateRemainingSeconds(50, 10000)).toBe(10);
    expect(estimateRemainingSeconds(99, 99000)).toBe(1);
  });

  it('combines per-file progress into an overall percentage', () => {
    const base: VideoState = {
      status: 'running',
      total: 4,
      processed: 1,
      currentPath: 'C:\\a.mp4',
      percent: 50,
      phase: 'encoding',
      fps: null,
      speed: null,
      etaSeconds: null,
      startedAt: 1,
      fileStartedAt: 2,
      results: [],
    };
    expect(overallVideoPercent(base)).toBe(37);
    expect(overallVideoPercent({ ...base, percent: 0, processed: 0 })).toBe(0);
    expect(overallVideoPercent({ ...base, status: 'completed', processed: 4 })).toBe(100);
    expect(overallVideoPercent({ ...base, total: 0 })).toBe(0);
  });

  it('rejects unsupported video rather than silently losing streams or color', () => {
    expect(inspectVideo(probe)).toEqual({ duration: 10, pixelFormat: 'yuv420p' });
    for (const change of [
      { color_transfer: 'smpte2084' },
      { pix_fmt: 'rgba' },
      { side_data_list: [{ rotation: 90 }] },
    ]) {
      expect(() =>
        inspectVideo({ ...probe, streams: [{ ...probe.streams[0], ...change }] }),
      ).toThrow();
    }
    expect(() => inspectVideo({ ...probe, streams: [] })).toThrow();
    expect(() =>
      inspectVideo({ ...probe, streams: [...probe.streams, { codec_type: 'data' }] }),
    ).toThrow();
  });

  it('verifies complete output including copied tracks, dimensions and duration', () => {
    const good = {
      ...probe,
      streams: [{ ...probe.streams[0], codec_name: 'hevc' }, probe.streams[1]],
    };
    expect(() => verifyVideoOutput(probe, good)).not.toThrow();
    expect(() => verifyVideoOutput(probe, { ...good, format: { duration: '2' } })).toThrow();
    expect(() => verifyVideoOutput(probe, { ...good, streams: [good.streams[0]] })).toThrow();
    expect(() =>
      verifyVideoOutput(probe, {
        ...good,
        streams: [{ ...good.streams[0], width: 1280 }, good.streams[1]],
      }),
    ).toThrow();
  });

  it('validates IPC input and rejects executable options or empty queues', () => {
    const good = { paths: ['C:\\a.mp4'], outputDir: 'D:\\out', quality: 'quality' };
    expect(videoStartSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, paths: [] },
      { ...good, quality: '-y' },
      { ...good, outputDir: '\0' },
      { ...good, executable: 'cmd.exe' },
    ]) {
      expect(videoStartSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bundles offline tools with licenses outside asar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    expect(pkg.build.extraResources).toContainEqual({
      from: 'build/ffmpeg',
      to: 'ffmpeg',
      filter: ['*.exe', 'LICENSE', 'README.txt', 'provenance.json'],
    });
    expect(pkg.scripts['build:win']).toContain('prepare:video');
  });
});
