import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveService, archiveEntryName } from '../../src/main/services/archiveService';

let root: string;
let sources: Array<{ path: string; size: number; mtimeMs: number }>;
const hash = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = (file: string) => ({
  path: file,
  size: fs.statSync(file).size,
  mtimeMs: fs.statSync(file).mtimeMs,
});
const service = () => new ArchiveService(() => new Set([root.slice(0, 2).toUpperCase()]));
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-archive-test-'));
  sources = ['甲/同名 & 文件.txt', '乙/同名 & 文件.txt', 'empty.txt'].map((name, index) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, index === 2 ? '' : `${index} sample data\n`.repeat(10000));
    return record(file);
  });
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('real lossless archives', () => {
  for (const format of ['zip', 'tar.gz'] as const) {
    it(`${format} extracts byte-identical content, preserving originals and existing output`, async () => {
      const output = fs.mkdtempSync(path.join(root, 'output-'));
      const existing = path.join(output, `文件打包.${format}`);
      fs.writeFileSync(existing, 'existing archive');
      const originals = sources.map((file) => hash(file.path));
      const job = service();
      job.start({ sources, outputDir: output, name: '文件打包', format });
      expect(() => job.start({ sources, outputDir: output, name: 'again', format })).toThrow(
        '正在进行',
      );
      await job.whenIdle();
      const state = job.getState();
      expect(state.status, state.message).toBe('completed');
      expect(state.processed).toBe(3);
      expect(state.outputPath).toContain(` (1).${format}`);
      expect(state.outputBytes).toBeLessThan(sources.reduce((sum, file) => sum + file.size, 0));
      expect(fs.readFileSync(existing, 'utf8')).toBe('existing archive');
      const extracted = fs.mkdtempSync(path.join(root, 'extract-'));
      execFileSync(tar, ['-xf', state.outputPath!, '-C', extracted], { windowsHide: true });
      sources.forEach((file, index) => {
        expect(hash(path.join(extracted, archiveEntryName(file.path)))).toBe(originals[index]);
        expect(hash(file.path)).toBe(originals[index]);
      });
      expect(fs.readdirSync(output).some((name) => name.startsWith('.disk-organizer-'))).toBe(
        false,
      );
    }, 30000);
  }

  it('rejects changed or missing indexed sources and leaves no partial archive', async () => {
    for (const source of [
      { ...sources[0], size: 1 },
      { ...sources[0], path: path.join(root, 'missing.txt') },
    ]) {
      const output = fs.mkdtempSync(path.join(root, 'failed-'));
      const job = service();
      job.start({ sources: [source], outputDir: output, name: 'bad', format: 'zip' });
      await job.whenIdle();
      expect(job.getState().status).toBe('failed');
      expect(fs.readdirSync(output)).toEqual([]);
    }
  });

  it('cancels an active stream, cleans its files, then permits another task', async () => {
    const file = path.join(root, 'large.bin');
    fs.writeFileSync(file, randomBytes(16 * 1024 * 1024));
    const original = hash(file);
    const output = fs.mkdtempSync(path.join(root, 'cancel-'));
    const job = service();
    job.start({ sources: [record(file)], outputDir: output, name: 'cancel', format: 'zip' });
    await new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        if (job.getState().percent > 0) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      }, 5);
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('archive did not start'));
      }, 10000);
    });
    job.cancel();
    await job.whenIdle();
    expect(job.getState().status).toBe('cancelled');
    expect(hash(file)).toBe(original);
    expect(fs.readdirSync(output)).toEqual([]);
    job.start({ sources, outputDir: output, name: 'after', format: 'tar.gz' });
    await job.whenIdle();
    expect(job.getState().status).toBe('completed');
  }, 30000);

  it('discards an archive if a source changes during streaming', async () => {
    const file = path.join(root, 'changing.bin');
    fs.writeFileSync(file, randomBytes(16 * 1024 * 1024));
    const output = fs.mkdtempSync(path.join(root, 'changing-'));
    const job = service();
    job.start({ sources: [record(file)], outputDir: output, name: 'changed', format: 'zip' });
    let changed = false;
    const timer = setInterval(() => {
      if (!changed && job.getState().percent > 0) {
        fs.appendFileSync(file, 'changed externally');
        changed = true;
      }
    }, 1);
    try {
      await job.whenIdle();
    } finally {
      clearInterval(timer);
    }
    expect(changed).toBe(true);
    expect(job.getState().status).toBe('failed');
    expect(job.getState().message).toContain('发生变化');
    expect(fs.readdirSync(output)).toEqual([]);
    expect(fs.statSync(file).size).toBe(16 * 1024 * 1024 + Buffer.byteLength('changed externally'));
  }, 30000);

  it('rejects non-local output and sources without copying them', async () => {
    const job = service();
    for (const outputDir of ['relative', '\\\\server\\share', 'C:\\a:stream']) {
      expect(() => job.start({ sources, outputDir, name: 'bad', format: 'zip' })).toThrow();
    }
    const output = fs.mkdtempSync(path.join(root, 'unsafe-'));
    job.start({
      sources: [{ path: '\\\\server\\share\\a.txt', size: 1, mtimeMs: 0 }],
      outputDir: output,
      name: 'bad',
      format: 'zip',
    });
    await job.whenIdle();
    expect(job.getState().status).toBe('failed');
    expect(fs.readdirSync(output)).toEqual([]);
  });
});
