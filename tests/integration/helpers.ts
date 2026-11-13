import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface ScanFixture {
  root: string;
  excludedDir: string;
  hiddenFile: string;
  systemFile: string;
  junctionPath: string;
  expectedFiles: string[];
  expectedBytes: number;
  cleanup(): void;
  snapshot(): Map<string, { hash: string; mtimeMs: number }>;
}

function attrib(args: string[]): void {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe');
  execFileSync(exe, args, { windowsHide: true });
}

export function createScanFixture(): ScanFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-scan-'));
  const docs = path.join(root, 'docs');
  const media = path.join(root, 'media');
  const excludedDir = path.join(root, 'excluded');
  const recycleDir = path.join(root, '$Recycle.Bin');
  const sviDir = path.join(root, 'System Volume Information');
  for (const dir of [docs, media, excludedDir, recycleDir, sviDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const a = path.join(docs, 'a.txt');
  fs.writeFileSync(a, 'hello world!');
  fs.writeFileSync(path.join(docs, 'b.pdf'), Buffer.alloc(100, 0x42));
  fs.writeFileSync(path.join(media, 'video.mp4'), Buffer.alloc(5000, 0x56));
  fs.writeFileSync(path.join(media, 'photo.JPG'), Buffer.alloc(300, 0x50));
  fs.writeFileSync(path.join(root, 'zero.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(root, 'README'), 'plain');
  fs.writeFileSync(path.join(root, 'My$Recycle.Bin note.txt'), 'not-excluded');
  fs.linkSync(a, path.join(root, 'link.txt'));
  fs.writeFileSync(path.join(excludedDir, 'inner.txt'), 'excluded');
  fs.writeFileSync(path.join(recycleDir, 'x.txt'), 'recycle');
  fs.writeFileSync(path.join(sviDir, 'y.txt'), 'svi');

  const hiddenFile = path.join(root, 'hidden.txt');
  fs.writeFileSync(hiddenFile, 'hidden');
  const systemFile = path.join(root, 'system.bin');
  fs.writeFileSync(systemFile, 'system');
  attrib(['+h', hiddenFile]);
  attrib(['+s', systemFile]);

  const junctionPath = path.join(root, 'junction-docs');
  fs.symlinkSync(docs, junctionPath, 'junction');

  const expectedFiles = [
    path.join(root, 'My$Recycle.Bin note.txt'),
    path.join(root, 'README'),
    path.join(root, 'link.txt'),
    path.join(root, 'zero.bin'),
    path.join(docs, 'a.txt'),
    path.join(docs, 'b.pdf'),
    path.join(media, 'photo.JPG'),
    path.join(media, 'video.mp4'),
  ].sort((l, r) => l.toLowerCase().localeCompare(r.toLowerCase()));
  const expectedBytes = expectedFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);

  function snapshot(): Map<string, { hash: string; mtimeMs: number }> {
    const result = new Map<string, { hash: string; mtimeMs: number }>();
    for (const file of expectedFiles) {
      const stats = fs.statSync(file);
      result.set(file.toLowerCase(), {
        hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        mtimeMs: stats.mtimeMs,
      });
    }
    return result;
  }

  function cleanup(): void {
    try {
      attrib(['-h', hiddenFile]);
    } catch {
      // Attribute reset is best effort.
    }
    try {
      attrib(['-s', systemFile]);
    } catch {
      // Attribute reset is best effort.
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // OS temp cleanup covers leftover fixture data.
    }
  }

  return {
    root,
    excludedDir,
    hiddenFile,
    systemFile,
    junctionPath,
    expectedFiles,
    expectedBytes,
    cleanup,
    snapshot,
  };
}

export function createTempDbPath(prefix = 'disk-organizer-db-'): {
  dir: string;
  dbPath: string;
  cleanup(): void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    dbPath: path.join(dir, 'index.db'),
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Best effort cleanup.
      }
    },
  };
}
