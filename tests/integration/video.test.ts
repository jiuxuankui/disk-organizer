import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VideoService } from '../../src/main/services/videoService';
import { probeVideo } from '../../src/main/services/videoCore';

const toolsDir = path.resolve('build/ffmpeg');
const ffmpeg = path.join(toolsDir, 'ffmpeg.exe');
const ffprobe = path.join(toolsDir, 'ffprobe.exe');
const hash = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let root: string;
let source: string;
let originalHash: string;

function service(): VideoService {
  return new VideoService({
    toolsDir,
    fixedDriveLetters: () => new Set([root.slice(0, 2).toUpperCase()]),
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-video-test-'));
  source = path.join(root, '画质 & 安全 sample.mkv');
  execFileSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_s16le',
      '-y',
      source,
    ],
    { windowsHide: true },
  );
  originalHash = hash(source);
}, 60000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('real local video compression', () => {
  it('compresses, preserves audio and quality geometry, never overwrites collisions or source', async () => {
    const output = fs.mkdtempSync(path.join(root, 'outputs-'));
    const existing = path.join(output, `${path.parse(source).name}.compressed.mkv`);
    fs.writeFileSync(existing, 'existing user data');
    const job = service();
    expect(
      job.start({ paths: [source, source], outputDir: output, quality: 'quality' }).total,
    ).toBe(1);
    expect(() => job.start({ paths: [source], outputDir: output, quality: 'quality' })).toThrow(
      '正在进行',
    );
    await job.whenIdle();
    const state = job.getState();
    expect(state.status).toBe('completed');
    const result = state.results[0];
    expect(result.message).toBe('压缩完成，原文件保留');
    expect(result.status).toBe('completed');
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
    expect(result.outputPath).toContain('(1).mkv');
    expect(hash(source)).toBe(originalHash);
    expect(fs.readFileSync(existing, 'utf8')).toBe('existing user data');
    expect(fs.readdirSync(output).some((file) => file.startsWith('.disk-organizer-video-'))).toBe(
      false,
    );
    const signal = new AbortController().signal;
    const metadata = await probeVideo(ffprobe, result.outputPath!, signal);
    expect(metadata.streams[0]).toMatchObject({
      codec_name: 'hevc',
      width: 320,
      height: 180,
      pix_fmt: 'yuv420p',
      avg_frame_rate: '24/1',
    });
    expect(metadata.streams[1].codec_name).toBe('pcm_s16le');
    const qualityCheck = spawnSync(
      ffmpeg,
      ['-i', source, '-i', result.outputPath!, '-lavfi', 'ssim', '-an', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(qualityCheck.status).toBe(0);
    const ssim = /All:([\d.]+)/.exec(qualityCheck.stderr)?.[1];
    expect(Number(ssim)).toBeGreaterThan(0.97);
  }, 60000);

  it('handles corrupt media and continues to the next video', async () => {
    const broken = path.join(root, 'broken.mp4');
    fs.writeFileSync(broken, 'not a video');
    const output = fs.mkdtempSync(path.join(root, 'mixed-'));
    const job = service();
    job.start({ paths: [broken, source], outputDir: output, quality: 'balanced' });
    await job.whenIdle();
    expect(job.getState().results.map((result) => result.status)).toEqual(['failed', 'completed']);
    expect(hash(source)).toBe(originalHash);
    expect(fs.readFileSync(broken, 'utf8')).toBe('not a video');
  }, 60000);

  it('cancels the process, clears only its temporary output, and permits a new run', async () => {
    const output = fs.mkdtempSync(path.join(root, 'cancel-'));
    const job = service();
    job.start({ paths: [source], outputDir: output, quality: 'quality' });
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (fs.readdirSync(output).some((name) => name.startsWith('.disk-organizer-video-'))) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve();
        }
      }, 5);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error('encoding never started'));
      }, 10000);
    });
    job.cancel();
    await job.whenIdle();
    expect(job.getState().status).toBe('cancelled');
    expect(job.isRunning()).toBe(false);
    expect(fs.readdirSync(output)).toEqual([]);
    expect(hash(source)).toBe(originalHash);
    job.start({ paths: [source], outputDir: output, quality: 'smaller' });
    await job.whenIdle();
    expect(job.getState().results[0].status).toBe('completed');
  }, 60000);

  it('discards larger encodes and preserves the original', async () => {
    const tiny = path.join(root, 'tiny.mp4');
    execFileSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:size=32x32:rate=1',
        '-t',
        '1',
        '-c:v',
        'libx264',
        tiny,
      ],
      { windowsHide: true },
    );
    const before = hash(tiny);
    const output = fs.mkdtempSync(path.join(root, 'larger-'));
    const job = service();
    job.start({ paths: [tiny], outputDir: output, quality: 'quality' });
    await job.whenIdle();
    expect(job.getState().results[0].status).toBe('skipped');
    expect(fs.readdirSync(output)).toEqual([]);
    expect(hash(tiny)).toBe(before);
  }, 30000);

  it('rejects URLs, UNC, device paths, streams, offline drives and unsupported files', () => {
    const job = service();
    for (const value of [
      'https://example.invalid/a.mp4',
      '\\\\server\\share\\a.mp4',
      '\\\\?\\C:\\a.mp4',
      'C:\\a.mp4:stream',
      'relative.mp4',
    ]) {
      expect(() => job.start({ paths: [value], outputDir: root, quality: 'quality' })).toThrow();
    }
    const noDrives = new VideoService({ toolsDir, fixedDriveLetters: () => new Set() });
    expect(() => noDrives.start({ paths: [source], outputDir: root, quality: 'quality' })).toThrow(
      '固定硬盘',
    );
    const text = path.join(root, 'document.txt');
    fs.writeFileSync(text, 'not video');
    expect(() => job.start({ paths: [text], outputDir: root, quality: 'quality' })).toThrow(
      '视频文件',
    );
  });
});
