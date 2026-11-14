import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ZipArchive } from 'archiver';
import { pipeline } from 'node:stream/promises';
import {
  ENV_DIR,
  ENV_NOTE_NAME,
  GUIDE_NAME,
  INSTALLER_DIR,
  RUNTIME_DIR,
  SUMS_NAME,
  bundleNames,
  createReleaseBundle,
  extractZip,
  runtimeEnvironmentNote,
  verifyReleaseBundle,
} from '../../scripts/release-bundle.mjs';

const VERSION = '9.8.7';
const PRODUCT = '硬盘整理';
const names = bundleNames(VERSION, PRODUCT);
const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fakeRelease(): { releaseDir: string; runtime: string; files: Map<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-release-'));
  roots.push(root);
  const releaseDir = path.join(root, 'release', VERSION);
  const runtime = path.join(releaseDir, 'win-unpacked');
  const files = new Map<string, string>([
    [names.executable, 'exe'],
    ['resources/app.asar', 'asar'],
    ['resources/app.asar.unpacked/node_modules/koffi/index.js', 'koffi'],
    ['resources/ffmpeg/ffmpeg.exe', 'ffmpeg'],
    ['resources/ffmpeg/ffprobe.exe', 'ffprobe'],
    ['resources/ffmpeg/LICENSE', 'GPL'],
    ['resources/ffmpeg/provenance.json', '{}'],
    ['locales/zh-CN.pak', 'locale'],
    ['资源 文件/说明 (1).txt', '中文内容'],
  ]);
  for (const [name, content] of files) write(path.join(runtime, name), content);
  fs.mkdirSync(path.join(runtime, 'empty-dir'));
  write(path.join(releaseDir, names.installer), Buffer.alloc(3 * 1024 * 1024, 7));
  return { releaseDir, runtime, files };
}

function extract(zipPath: string): string {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-unzip-'));
  roots.push(destination);
  extractZip(zipPath, destination);
  return destination;
}

describe('complete release bundle', () => {
  it('packs installer, every runtime file and a Chinese install guide that extract intact', async () => {
    const { releaseDir, runtime, files } = fakeRelease();
    const result = await createReleaseBundle({
      releaseDir,
      version: VERSION,
      productName: PRODUCT,
    });
    expect(result.zipPath).toBe(path.join(releaseDir, names.zip));
    expect(fs.readdirSync(releaseDir).filter((name) => name.endsWith('.part'))).toEqual([]);

    const extracted = extract(result.zipPath);
    expect(fs.readdirSync(extracted)).toEqual([names.root]);
    const root = path.join(extracted, names.root);
    expect(fs.readdirSync(root).sort()).toEqual(
      [ENV_DIR, GUIDE_NAME, INSTALLER_DIR, RUNTIME_DIR, SUMS_NAME].sort(),
    );
    expect(digest(path.join(root, INSTALLER_DIR, names.installer))).toBe(
      digest(path.join(releaseDir, names.installer)),
    );
    for (const name of files.keys()) {
      expect(fs.readFileSync(path.join(root, RUNTIME_DIR, name))).toEqual(
        fs.readFileSync(path.join(runtime, name)),
      );
    }
    expect(fs.statSync(path.join(root, RUNTIME_DIR, 'empty-dir')).isDirectory()).toBe(true);

    const guide = fs.readFileSync(path.join(root, GUIDE_NAME));
    expect([...guide.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = guide.toString('utf8');
    expect(text).not.toMatch(/[^\r]\n/);
    for (const phrase of [
      `${PRODUCT} ${VERSION} 安装说明`,
      `${INSTALLER_DIR}\\${names.installer}`,
      `${RUNTIME_DIR}”文件夹，双击“${names.executable}`,
      '覆盖安装到原目录',
      '之前的扫描结果和设置都会保留',
      '%LOCALAPPDATA%\\DiskOrganizer',
      '不会上传任何文件',
      'Get-FileHash',
      'GPL-3.0-or-later',
    ]) {
      expect(text).toContain(phrase);
    }
    expect(text).toContain(`${ENV_DIR}\\${ENV_NOTE_NAME}`);

    const envNote = fs.readFileSync(path.join(root, ENV_DIR, ENV_NOTE_NAME));
    expect([...envNote.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const envText = envNote.toString('utf8');
    expect(envText).not.toMatch(/[^\r]\n/);
    for (const phrase of [
      `${PRODUCT} ${VERSION} 运行环境说明`,
      'Electron',
      'FFmpeg',
      'Windows 10 / 11 64 位',
      'Microsoft Visual C++ 2015-2022',
      'learn.microsoft.com',
      '完全离线运行',
    ]) {
      expect(envText).toContain(phrase);
    }
    expect(envText).toBe(
      `\ufeff${runtimeEnvironmentNote(VERSION, PRODUCT).replace(/\r?\n/g, '\r\n')}`,
    );

    const sums = fs.readFileSync(path.join(root, SUMS_NAME), 'utf8').trim().split('\r\n');
    expect(sums).toHaveLength(files.size + 3);
    for (const line of sums) {
      const [hash, name] = line.split(' *');
      expect(digest(path.join(root, name))).toBe(hash);
    }
    expect(result.fileCount).toBe(files.size + 3);
    expect(result.sha256).toBe(digest(result.zipPath));

    await expect(
      verifyReleaseBundle({
        zipPath: result.zipPath,
        releaseDir,
        version: VERSION,
        productName: PRODUCT,
      }),
    ).resolves.toEqual({ fileCount: files.size + 3 });
  });

  it('never overwrites an existing bundle', async () => {
    const { releaseDir } = fakeRelease();
    const zipPath = path.join(releaseDir, names.zip);
    write(zipPath, 'previous bundle');
    await expect(
      createReleaseBundle({ releaseDir, version: VERSION, productName: PRODUCT }),
    ).rejects.toThrow(/压缩包已存在，未覆盖/);
    expect(fs.readFileSync(zipPath, 'utf8')).toBe('previous bundle');
    expect(fs.readdirSync(releaseDir).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('refuses incomplete runtime output and link entries without leaving a bundle', async () => {
    const missing = fakeRelease();
    fs.rmSync(path.join(missing.runtime, 'resources/ffmpeg/ffprobe.exe'));
    await expect(
      createReleaseBundle({
        releaseDir: missing.releaseDir,
        version: VERSION,
        productName: PRODUCT,
      }),
    ).rejects.toThrow(/发布文件缺失/);
    expect(fs.existsSync(path.join(missing.releaseDir, names.zip))).toBe(false);

    const linked = fakeRelease();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-outside-'));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(linked.runtime, 'linked'), 'junction');
    await expect(
      createReleaseBundle({
        releaseDir: linked.releaseDir,
        version: VERSION,
        productName: PRODUCT,
      }),
    ).rejects.toThrow(/不能包含链接/);
    expect(fs.readdirSync(linked.releaseDir).filter((name) => name.endsWith('.zip'))).toEqual([]);
    expect(fs.readdirSync(linked.releaseDir).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('detects tampered, extra or mismatched files when verifying', async () => {
    const { releaseDir } = fakeRelease();
    const { zipPath } = await createReleaseBundle({
      releaseDir,
      version: VERSION,
      productName: PRODUCT,
    });
    const options = { releaseDir, version: VERSION, productName: PRODUCT };

    const rebuild = async (mutate: (root: string) => void): Promise<string> => {
      const extracted = extract(zipPath);
      mutate(path.join(extracted, names.root));
      const target = path.join(path.dirname(extracted), `${path.basename(extracted)}.zip`);
      roots.push(target);
      const archive = new ZipArchive();
      const writing = pipeline(archive, fs.createWriteStream(target));
      archive.directory(extracted, false);
      await archive.finalize();
      await writing;
      return target;
    };

    const tampered = await rebuild((root) =>
      fs.appendFileSync(path.join(root, RUNTIME_DIR, 'resources/app.asar'), 'x'),
    );
    await expect(verifyReleaseBundle({ ...options, zipPath: tampered })).rejects.toThrow(
      /文件校验失败/,
    );

    const extra = await rebuild((root) => write(path.join(root, RUNTIME_DIR, 'extra.dll'), 'x'));
    await expect(verifyReleaseBundle({ ...options, zipPath: extra })).rejects.toThrow(
      /与校验清单不一致/,
    );

    const noEnvNote = await rebuild((root) => fs.rmSync(path.join(root, ENV_DIR, ENV_NOTE_NAME)));
    await expect(verifyReleaseBundle({ ...options, zipPath: noEnvNote })).rejects.toThrow(
      /与校验清单不一致/,
    );

    fs.appendFileSync(path.join(releaseDir, names.installer), 'rebuilt');
    await expect(verifyReleaseBundle({ ...options, zipPath })).rejects.toThrow(/与本次构建不一致/);
  });

  it('is wired after the NSIS build and outputs into a per-version folder', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.build.directories.output).toBe('release/${version}');
    expect(pkg.scripts['build:win']).toMatch(
      /electron-builder --win nsis && npm run release:bundle && npm run release:verify$/,
    );
    expect(pkg.scripts['release:verify']).toContain('--verify');
    expect(execFileSync('git', ['check-ignore', 'release/x.zip'], { encoding: 'utf8' })).toBe(
      'release/x.zip\n',
    );
  });
});
