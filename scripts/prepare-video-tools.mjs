import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tools = path.join(root, 'build', 'ffmpeg');
const downloadDir = path.join(root, 'build', '.tmp-video-download');
const version = '9.0.1';
const url =
  'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip';
const sha256 = 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9';
const digest = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Video tools require Windows x64');
}
let ready = false;
try {
  const manifest = JSON.parse(await fs.readFile(path.join(tools, 'provenance.json'), 'utf8'));
  ready = manifest.archiveSha256 === sha256;
  for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'README.txt']) {
    ready = ready && (await digest(path.join(tools, name))) === manifest.files[name];
  }
} catch {
  ready = false;
}

if (!ready) {
  await fs.mkdir(downloadDir, { recursive: true });
  let archiveName = (await fs.readdir(downloadDir)).find((name) => name.endsWith('.zip'));
  if (!archiveName) {
    execFileSync(
      'winget.exe',
      [
        'download',
        '--source',
        'winget',
        '--id',
        'Gyan.FFmpeg.Essentials',
        '--version',
        version,
        '--exact',
        '--download-directory',
        downloadDir,
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      { stdio: 'inherit' },
    );
    archiveName = (await fs.readdir(downloadDir)).find((name) => name.endsWith('.zip'));
  }
  if (!archiveName) throw new Error('FFmpeg archive not found');
  const archive = path.join(downloadDir, archiveName);
  if ((await digest(archive)) !== sha256)
    throw new Error('FFmpeg SHA-256 mismatch; no executable was installed');
  const staging = await fs.mkdtemp(path.join(root, 'build', '.tmp-ffmpeg-unpack-'));
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:VIDEO_ARCHIVE -DestinationPath $env:VIDEO_STAGING',
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, VIDEO_ARCHIVE: archive, VIDEO_STAGING: staging },
      },
    );
    const [folder] = await fs.readdir(staging);
    if (!folder?.startsWith(`ffmpeg-${version}`))
      throw new Error('Unexpected FFmpeg archive version');
    await fs.mkdir(tools, { recursive: true });
    const files = {};
    for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'README.txt']) {
      const source = path.join(staging, folder, name.endsWith('.exe') ? 'bin' : '', name);
      await fs.copyFile(source, path.join(tools, name));
      files[name] = await digest(source);
    }
    await fs.writeFile(
      path.join(tools, 'provenance.json'),
      JSON.stringify(
        {
          version,
          url,
          archiveSha256: sha256,
          files,
          provider: 'https://www.gyan.dev/ffmpeg/builds/',
          upstream: 'https://ffmpeg.org/download.html',
          source: 'https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a',
          license: 'GPL-3.0-or-later; separately executed command-line tools',
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) {
  const output = execFileSync(path.join(tools, tool), ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  console.log(output.split('\n')[0]);
}
