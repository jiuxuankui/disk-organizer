import { describe, expect, it } from 'vitest';
import {
  inspectVideo,
  verifyVideoOutput,
  videoEncodeArgs,
  videoProgress,
  type VideoProbe,
} from '../../src/main/services/videoCore';
import { videoStartSchema } from '../../src/main/ipc/schemas';
import { VIDEO_QUALITIES } from '../../src/shared/video';
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

  it('parses chunked process lines only when they contain usable progress', () => {
    expect(videoProgress('out_time_us=5000000', 10)).toBe(50);
    expect(videoProgress('out_time_us=10000000', 10)).toBe(99);
    expect(videoProgress('out_time_us=N/A', 10)).toBeNull();
    expect(videoProgress('speed=2.1x', 10)).toBeNull();
    expect(videoProgress('out_time_us=100', 0)).toBeNull();
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
