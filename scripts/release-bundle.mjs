import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZipArchive } from 'archiver';

export const INSTALLER_DIR = '安装程序';
export const RUNTIME_DIR = '运行文件';
export const GUIDE_NAME = '安装说明.txt';
export const SUMS_NAME = 'SHA256SUMS.txt';

const RUNTIME_REQUIRED = [
  'resources/app.asar',
  'resources/app.asar.unpacked/node_modules/koffi',
  'resources/ffmpeg/ffmpeg.exe',
  'resources/ffmpeg/ffprobe.exe',
  'resources/ffmpeg/LICENSE',
  'resources/ffmpeg/provenance.json',
];

export function bundleNames(version, productName) {
  return {
    installer: `DiskOrganizer-Setup-${version}.exe`,
    executable: `${productName}.exe`,
    root: `${productName}-${version}`,
    zip: `DiskOrganizer-${version}-完整安装包.zip`,
  };
}

export function installGuide(version, productName) {
  const names = bundleNames(version, productName);
  return `${productName} ${version} 安装说明
========================================

本软件只在本机离线运行，不需要登录，不会上传任何文件或数据。

一、系统要求
- Windows 10 / 11 64 位
- 只处理本地固定硬盘（不处理移动硬盘、U 盘、网络盘）
- 已内置视频编码工具 FFmpeg，无需另行安装任何运行环境

二、使用前
请先把整个压缩包完整解压到本地硬盘，不要在压缩软件里直接双击运行。
可以先核对完整性：在解压后的文件夹中打开 PowerShell，运行
  Get-FileHash -Algorithm SHA256 ".\\${INSTALLER_DIR}\\${names.installer}"
并与 ${SUMS_NAME} 中对应的值比较，一致即表示文件完好。

三、方式一：安装（推荐）
1. 双击“${INSTALLER_DIR}\\${names.installer}”，按向导安装，可自选安装目录。
   安装只针对当前 Windows 用户，不需要管理员权限。
2. 如果电脑上已安装旧版本，安装程序会提示并覆盖安装到原目录；
   之前的扫描结果和设置都会保留，不需要重新扫描。
3. 安装完成后，从“开始”菜单打开“${productName}”。

四、方式二：免安装直接运行
1. 进入“${RUNTIME_DIR}”文件夹，双击“${names.executable}”即可运行。
2. 请保持“${RUNTIME_DIR}”文件夹完整，不要只单独复制 exe。
3. 免安装版与安装版共用同一份数据，不要同时打开两个版本。
4. 免安装版不会创建开始菜单快捷方式，也不需要卸载，删除文件夹即可。

五、首次使用
1. 点击侧边栏底部“重新扫描”，勾选要扫描的硬盘并确认。
2. 扫描完成后在“总览”“全部文件”“重复文件”“归类整理”中查看和处理文件。
3. 删除只会把文件移到 Windows 回收站，可以还原；清空回收站后才会释放空间。

六、Windows 安全提示
安装程序未做代码签名，Windows SmartScreen 可能提示“Windows 已保护你的电脑”，
确认来源可信后选择“更多信息 → 仍要运行”即可。

七、数据位置与卸载
- 扫描结果、设置、备份和日志保存在 %LOCALAPPDATA%\\DiskOrganizer\\
- 在“设置 → 应用和功能”中卸载时不会删除上述数据，重新安装后可继续使用。
- 需要彻底清除数据时，手动删除 %LOCALAPPDATA%\\DiskOrganizer 文件夹。

八、第三方组件
视频编码工具 FFmpeg 以独立程序方式随附，遵循 GPL-3.0-or-later 许可，
许可证与来源信息见“${RUNTIME_DIR}\\resources\\ffmpeg\\”中的 LICENSE、README.txt 和 provenance.json。
`;
}

function listRuntime(root) {
  const entries = [];
  const walk = (relative) => {
    const directory = path.join(root, relative);
    const children = fs.readdirSync(directory, { withFileTypes: true });
    if (relative && children.length === 0) entries.push({ relative, directory: true });
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const stats = fs.lstatSync(path.join(root, childRelative));
      if (stats.isSymbolicLink()) throw new Error(`运行文件中不能包含链接：${childRelative}`);
      if (stats.isDirectory()) walk(childRelative);
      else if (stats.isFile()) entries.push({ relative: childRelative, directory: false });
      else throw new Error(`运行文件中包含不支持的条目：${childRelative}`);
    }
  };
  walk('');
  return entries.sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createReleaseBundle({ releaseDir, version, productName }) {
  const names = bundleNames(version, productName);
  const installer = path.join(releaseDir, names.installer);
  const runtime = path.join(releaseDir, 'win-unpacked');
  const zipPath = path.join(releaseDir, names.zip);
  for (const required of [
    installer,
    path.join(runtime, names.executable),
    ...RUNTIME_REQUIRED.map((item) => path.join(runtime, item)),
  ]) {
    if (!fs.existsSync(required)) throw new Error(`发布文件缺失，未生成压缩包：${required}`);
  }
  if (fs.existsSync(zipPath)) throw new Error(`压缩包已存在，未覆盖：${zipPath}`);

  const files = [
    { source: installer, name: `${INSTALLER_DIR}/${names.installer}` },
    ...listRuntime(runtime).map((entry) => ({
      source: path.join(runtime, entry.relative),
      name: `${RUNTIME_DIR}/${entry.relative}`,
      directory: entry.directory,
    })),
  ];
  const guide = Buffer.from(
    `\ufeff${installGuide(version, productName).replace(/\r?\n/g, '\r\n')}`,
    'utf8',
  );
  const sums = [`${createHash('sha256').update(guide).digest('hex')} *${GUIDE_NAME}`];
  for (const file of files) {
    if (!file.directory) {
      file.stats = fs.statSync(file.source);
      sums.push(`${await sha256File(file.source)} *${file.name}`);
    }
  }

  const part = path.join(releaseDir, `.${names.zip}.${randomUUID()}.part`);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('warning', (error) => archive.destroy(error));
  const writing = pipeline(archive, fs.createWriteStream(part, { flags: 'wx' }));
  writing.catch(() => undefined);
  try {
    archive.append(guide, { name: `${names.root}/${GUIDE_NAME}` });
    archive.append(`${sums.join('\r\n')}\r\n`, { name: `${names.root}/${SUMS_NAME}` });
    for (const file of files) {
      const name = `${names.root}/${file.name}`;
      if (file.directory) {
        archive.append(null, { name: `${name}/`, type: 'directory' });
        continue;
      }
      archive.append(fs.createReadStream(file.source), {
        name,
        date: file.stats.mtime,
        store: file.source === installer,
      });
    }
    await archive.finalize();
    await writing;
    for (const file of files) {
      if (file.directory) continue;
      const after = fs.statSync(file.source);
      if (after.size !== file.stats.size || after.mtimeMs !== file.stats.mtimeMs)
        throw new Error(`打包期间文件发生变化：${file.source}`);
    }
    fs.linkSync(part, zipPath);
  } catch (error) {
    archive.abort();
    await writing.catch(() => undefined);
    throw error;
  } finally {
    fs.rmSync(part, { force: true });
  }
  return {
    zipPath,
    fileCount: sums.length,
    bytes: fs.statSync(zipPath).size,
    sha256: await sha256File(zipPath),
  };
}

export function extractZip(zipPath, destination) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:BUNDLE_ZIP -DestinationPath $env:BUNDLE_DEST",
    ],
    {
      env: { ...process.env, BUNDLE_ZIP: zipPath, BUNDLE_DEST: destination },
      windowsHide: true,
      stdio: 'pipe',
    },
  );
}

function smokeLaunch(executable, dataDir) {
  const env = { ...process.env, DISK_ORGANIZER_SMOKE_EXIT: '1', DISK_ORGANIZER_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [], {
    env,
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.includes('SMOKE_WINDOW_LOADED'))
    throw new Error(`解压后的程序未能正常启动（退出码 ${result.status}）：${result.stderr}`);
}

export async function verifyReleaseBundle({
  zipPath,
  releaseDir,
  version,
  productName,
  launch = false,
}) {
  const names = bundleNames(version, productName);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-bundle-'));
  try {
    const extracted = path.join(work, 'extracted');
    extractZip(zipPath, extracted);
    const top = fs.readdirSync(extracted);
    if (top.length !== 1 || top[0] !== names.root)
      throw new Error(`压缩包顶层应只有“${names.root}”文件夹`);
    const root = path.join(extracted, names.root);
    const guide = fs.readFileSync(path.join(root, GUIDE_NAME));
    if (!guide.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      throw new Error('安装说明缺少 UTF-8 标记');
    if (!guide.toString('utf8').includes(names.installer)) throw new Error('安装说明与版本不一致');
    const expected = new Map();
    for (const line of fs.readFileSync(path.join(root, SUMS_NAME), 'utf8').trim().split('\r\n')) {
      const match = /^([0-9a-f]{64}) \*(.+)$/.exec(line);
      if (!match) throw new Error(`校验清单格式错误：${line}`);
      expected.set(match[2], match[1]);
    }
    const actual = listRuntime(root)
      .filter((entry) => !entry.directory && entry.relative !== SUMS_NAME)
      .map((entry) => entry.relative);
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name)))
      throw new Error('压缩包内容与校验清单不一致');
    for (const name of actual) {
      if ((await sha256File(path.join(root, name))) !== expected.get(name))
        throw new Error(`文件校验失败：${name}`);
    }
    const installerName = `${INSTALLER_DIR}/${names.installer}`;
    if (!expected.has(installerName)) throw new Error('压缩包缺少安装程序');
    if (
      releaseDir &&
      (await sha256File(path.join(releaseDir, names.installer))) !== expected.get(installerName)
    )
      throw new Error('压缩包中的安装程序与本次构建不一致');
    const runtime = path.join(root, RUNTIME_DIR);
    for (const item of [names.executable, ...RUNTIME_REQUIRED]) {
      if (!fs.existsSync(path.join(runtime, item))) throw new Error(`运行文件缺失：${item}`);
    }
    if (launch) {
      for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) {
        execFileSync(path.join(runtime, 'resources', 'ffmpeg', tool), ['-version'], {
          windowsHide: true,
          stdio: 'pipe',
        });
      }
      smokeLaunch(path.join(runtime, names.executable), path.join(work, 'data'));
    }
    return { fileCount: expected.size };
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const releaseDir = path.join(root, 'release', pkg.version);
  const options = { releaseDir, version: pkg.version, productName: pkg.build.productName };
  if (process.argv.includes('--verify')) {
    const zipPath = path.join(releaseDir, bundleNames(pkg.version, pkg.build.productName).zip);
    const result = await verifyReleaseBundle({ ...options, zipPath, launch: true });
    console.log(`完整安装压缩包校验通过：${result.fileCount} 个文件，解压后可启动`);
  } else {
    const result = await createReleaseBundle(options);
    console.log(`完整安装压缩包：${result.zipPath}`);
    console.log(`包含 ${result.fileCount} 个文件，${result.bytes} 字节，SHA-256 ${result.sha256}`);
  }
}
