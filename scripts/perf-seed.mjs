import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.disk-organizer-perf';

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const root = path.resolve(
  readOption('root', process.env.DISK_ORGANIZER_PERF_DIR ?? path.join(os.tmpdir(), 'disk-organizer-perf')),
);
const emptyCount = Number(readOption('empty', '200000'));
const dirCount = Number(readOption('dirs', '20000'));
const dupCount = Number(readOption('dup-count', '1000'));
const dupSizeMb = Number(readOption('dup-size-mb', '2'));

function cleanup() {
  if (!fs.existsSync(root)) {
    console.log('目录不存在，无需清理');
    return;
  }
  if (!fs.existsSync(path.join(root, MARKER))) {
    throw new Error(`目录 ${root} 不是性能测试目录（缺少 ${MARKER}），已停止清理`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`已清理 ${root}`);
}

function prepare() {
  if (fs.existsSync(root)) {
    if (!fs.existsSync(path.join(root, MARKER))) {
      throw new Error(`目录 ${root} 已存在且不是性能测试目录，请换一个路径`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), 'disk-organizer perf data\n');
}

function seedEmptyFiles() {
  const perDir = Math.ceil(emptyCount / dirCount);
  const startedAt = Date.now();
  let created = 0;
  for (let dirIndex = 0; dirIndex < dirCount; dirIndex += 1) {
    const dir = path.join(root, 'empty', `d${String(dirIndex).padStart(5, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let fileIndex = 0; fileIndex < perDir && created < emptyCount; fileIndex += 1) {
      fs.writeFileSync(
        path.join(dir, `f${String(fileIndex).padStart(3, '0')}.txt`),
        Buffer.alloc(0),
      );
      created += 1;
    }
    if (created % 20000 === 0) {
      console.log(`空文件进度 ${created}/${emptyCount}`);
    }
  }
  console.log(`空文件 ${created} 个，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

function seedDuplicates() {
  const dir = path.join(root, 'dup');
  fs.mkdirSync(dir, { recursive: true });
  const content = Buffer.alloc(dupSizeMb * 1024 * 1024, 0x5a);
  const startedAt = Date.now();
  for (let index = 0; index < dupCount; index += 1) {
    fs.writeFileSync(
      path.join(dir, `dup-${String(index).padStart(4, '0')}.bin`),
      content,
    );
    if ((index + 1) % 200 === 0) {
      console.log(`重复文件进度 ${index + 1}/${dupCount}`);
    }
  }
  console.log(
    `重复文件 ${dupCount} 个 × ${dupSizeMb}MB，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

try {
  if (process.argv.includes('--clean')) {
    cleanup();
  } else {
    prepare();
    seedEmptyFiles();
    seedDuplicates();
    const totalBytes = dupCount * dupSizeMb * 1024 * 1024;
    console.log(
      JSON.stringify(
        {
          root,
          emptyFiles: emptyCount,
          directories: dirCount + 1,
          duplicateFiles: dupCount,
          duplicateBytes: totalBytes,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
