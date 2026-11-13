import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getFileIdentity,
  safeLstat,
  toExtendedPath,
} from '../../src/main/services/filesystem';
import {
  readFileAttributes,
  readRegistryDword,
  listFixedDrives,
  DRIVE_FIXED,
} from '../../src/main/services/windowsService';

const isWin = process.platform === 'win32';
const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function attrib(args: string[]): void {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe');
  execFileSync(exe, args, { windowsHide: true });
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Temporary test data may be locked briefly; OS temp cleanup covers the rest.
    }
  }
});

describe.runIf(isWin)('Windows drive enumeration', () => {
  it('lists fixed drives with capacity data', () => {
    const drives = listFixedDrives();
    expect(drives.length).toBeGreaterThan(0);
    const systemDrive = drives.find((d) => d.letter.toUpperCase() === 'C:');
    expect(systemDrive).toBeTruthy();
    for (const drive of drives) {
      expect(drive.type).toBe(DRIVE_FIXED);
      expect(drive.letter).toMatch(/^[A-Z]:$/);
      expect(drive.root).toBe(`${drive.letter}\\`);
      expect(drive.totalBytes).toBeGreaterThan(0);
      expect(drive.freeBytes).toBeGreaterThanOrEqual(0);
      expect(drive.freeBytes).toBeLessThanOrEqual(drive.totalBytes);
      expect(drive.fileSystem.length).toBeGreaterThan(0);
      expect(drive.serial).toMatch(/^[0-9a-f]{8}$/);
      expect(drive.ready).toBe(true);
    }
  });

  it('matches fs.statfs capacity within one percent', () => {
    const drives = listFixedDrives();
    for (const drive of drives) {
      const stat = fs.statfsSync(drive.root);
      const total = Number(stat.blocks) * Number(stat.bsize);
      const free = Number(stat.bfree) * Number(stat.bsize);
      expect(Math.abs(total - drive.totalBytes) / total).toBeLessThan(0.01);
      expect(Math.abs(free - drive.freeBytes) / Math.max(total, 1)).toBeLessThan(0.01);
    }
  });

  it('reads registry dwords from HKLM', () => {
    const value = readRegistryDword(
      'localMachine',
      'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      'CurrentMajorVersionNumber',
    );
    expect(value).toBeGreaterThanOrEqual(10);
    const missing = readRegistryDword(
      'currentUser',
      'Software\\DiskOrganizer\\DefinitelyMissingKey',
      'NoSuchValue',
    );
    expect(missing).toBeNull();
  });
});

describe.runIf(isWin)('file attributes', () => {
  it('detects hidden and system attributes', () => {
    const dir = makeTempDir('disk-organizer-attr-');
    const file = path.join(dir, 'plain.txt');
    fs.writeFileSync(file, 'plain');

    const plain = readFileAttributes(file);
    expect(plain).not.toBeNull();
    expect(plain?.hidden).toBe(false);
    expect(plain?.system).toBe(false);
    expect(plain?.directory).toBe(false);

    attrib(['+h', '+s', file]);
    try {
      const hidden = readFileAttributes(file);
      expect(hidden?.hidden).toBe(true);
      expect(hidden?.system).toBe(true);
    } finally {
      attrib(['-h', '-s', file]);
    }

    expect(readFileAttributes(path.join(dir, 'missing.txt'))).toBeNull();
  });

  it('reads a path longer than 260 characters', () => {
    const base = makeTempDir('disk-organizer-long-');
    let current = base;
    for (let i = 0; i < 8; i++) {
      current = path.join(current, `segment-${i}-${'x'.repeat(30)}`);
    }
    fs.mkdirSync(toExtendedPath(current), { recursive: true });
    const file = path.join(current, 'deep.txt');
    fs.writeFileSync(toExtendedPath(file), 'deep-content');
    expect(file.length).toBeGreaterThan(260);

    const stats = safeLstat(file);
    expect(stats).not.toBeNull();
    expect(stats?.size).toBe(12);
    const identity = getFileIdentity(file);
    expect(identity).not.toBeNull();
    expect(identity?.fileId).not.toBe('0');
  });
});

describe.runIf(isWin)('hard link identity', () => {
  it('gives the same identity to two hard links and different identity elsewhere', () => {
    const dir = makeTempDir('disk-organizer-link-');
    const first = path.join(dir, 'first.bin');
    const second = path.join(dir, 'second.bin');
    const other = path.join(dir, 'other.bin');
    fs.writeFileSync(first, 'same-content');
    fs.linkSync(first, second);
    fs.writeFileSync(other, 'other-content');

    const a = getFileIdentity(first);
    const b = getFileIdentity(second);
    const c = getFileIdentity(other);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(c).not.toBeNull();
    expect(c?.fileId).not.toBe(a?.fileId);
  });
});
