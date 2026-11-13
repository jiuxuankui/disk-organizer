import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKER = '.disk-organizer-fixture';
const root = path.resolve(
  process.env.DISK_ORGANIZER_FIXTURE_DIR ??
    process.argv[2] ??
    path.join(os.tmpdir(), 'disk-organizer-fixtures'),
);

function cleanup(): void {
  if (!fs.existsSync(root)) return;
  if (!fs.existsSync(path.join(root, MARKER))) {
    throw new Error(`目录 ${root} 不是测试夹具目录（缺少 ${MARKER}），已停止清理`);
  }
  allowRead(path.join(root, 'denied', 'secret.txt'));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`已清理 ${root}`);
}

function longPathPrefix(target) {
  return process.platform === 'win32' ? `\\\\?\\${target}` : target;
}

function writeLongPath(baseDir) {
  let current = path.join(baseDir, 'longpath');
  const segment = 'segment-0123456789';
  while (current.length < 280) {
    current = path.join(current, segment);
  }
  fs.mkdirSync(longPathPrefix(current), { recursive: true });
  const file = path.join(current, 'deep-file.txt');
  fs.writeFileSync(longPathPrefix(file), 'deep file');
  return file;
}

function denyRead(file) {
  const user = process.env.USERNAME;
  if (!user) return false;
  const result = spawnSync('icacls', [file, '/deny', `${user}:(R)`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function allowRead(file) {
  const user = process.env.USERNAME;
  if (!user || !fs.existsSync(file)) return;
  spawnSync('icacls', [file, '/remove:d', user], { encoding: 'utf8' });
}

function main() {
  if (process.argv.includes('--clean')) {
    cleanup();
    return;
  }

  if (fs.existsSync(root)) {
    if (!fs.existsSync(path.join(root, MARKER))) {
      throw new Error(`目录 ${root} 已存在且不是测试夹具目录，请换一个路径`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), 'disk-organizer test fixture\n');

  const twoMbA = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const twoMbB = Buffer.alloc(2 * 1024 * 1024, 0x42);
  fs.writeFileSync(path.join(root, 'same-a.txt'), twoMbA);
  fs.writeFileSync(path.join(root, 'same-b.txt'), twoMbA);
  fs.writeFileSync(path.join(root, 'same-size-diff.txt'), twoMbB);
  fs.writeFileSync(path.join(root, 'zero-a.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(root, 'zero-b.bin'), Buffer.alloc(0));

  const mixed = Buffer.from('identical jpeg and png payload');
  fs.writeFileSync(path.join(root, 'mixed-a.jpg'), mixed);
  fs.writeFileSync(path.join(root, 'mixed-b.png'), mixed);

  const big = Buffer.alloc(1024 * 1024, 0x49);
  const bigHandle = fs.openSync(path.join(root, 'big-1.iso'), 'w');
  for (let index = 0; index < 100; index += 1) {
    fs.writeSync(bigHandle, big);
  }
  fs.closeSync(bigHandle);

  const hidden = path.join(root, 'hidden-system.txt');
  fs.writeFileSync(hidden, 'hidden and system file');
  if (process.platform === 'win32') {
    spawnSync('attrib', ['+h', '+s', hidden]);
  }

  fs.mkdirSync(path.join(root, 'denied'), { recursive: true });
  const denied = path.join(root, 'denied', 'secret.txt');
  fs.writeFileSync(denied, 'no read permission');
  const deniedApplied = denyRead(denied);

  fs.mkdirSync(path.join(root, 'cross-drive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cross-drive', 'same-a.txt'), twoMbA);
  fs.writeFileSync(path.join(root, 'locked.bin'), Buffer.alloc(4096, 0x4c));
  fs.writeFileSync(path.join(root, 'missing.txt'), 'deleted after scanning');

  const deepFile = writeLongPath(root);

  const summary = {
    root,
    files: 14,
    duplicatePair: ['same-a.txt', 'same-b.txt'],
    sameSizeDifferent: 'same-size-diff.txt',
    zeroByte: ['zero-a.bin', 'zero-b.bin'],
    mixedExtensions: ['mixed-a.jpg', 'mixed-b.png'],
    bigFile: 'big-1.iso',
    hiddenSystem: 'hidden-system.txt',
    deniedRead: deniedApplied ? 'denied/secret.txt' : null,
    longPath: deepFile,
    lockedFile: 'locked.bin',
    missingAfterScan: 'missing.txt',
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!deniedApplied) {
    console.warn('未能设置无读取权限文件（icacls 不可用），跳过该夹具');
  }
  console.warn(
    'denied/secret.txt 使用 icacls 拒绝当前用户读取，清理前请先运行 --clean（会自动解除拒绝）。',
  );

  if (process.argv.includes('--clean-permission')) {
    allowRead(denied);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
