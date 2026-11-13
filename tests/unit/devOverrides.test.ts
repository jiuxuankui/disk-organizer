import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFakeRecyclePolicy,
  createFakeTrashItem,
  missingScanRoots,
  readDevOverrides,
} from '../../src/main/devOverrides';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-dev-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('development overrides', () => {
  it('parses scan roots and fake trash from env', () => {
    expect(readDevOverrides({})).toEqual({ scanRoots: null, fakeTrashDir: null });
    expect(
      readDevOverrides({
        DISK_ORGANIZER_SCAN_ROOTS: ' C:\\fixture ; D:\\other ',
        DISK_ORGANIZER_FAKE_TRASH_DIR: ' C:\\trash ',
      }),
    ).toEqual({
      scanRoots: ['C:\\fixture', 'D:\\other'],
      fakeTrashDir: 'C:\\trash',
    });
    expect(
      readDevOverrides({ DISK_ORGANIZER_SCAN_ROOTS: ' ; ', DISK_ORGANIZER_FAKE_TRASH_DIR: '' }),
    ).toEqual({ scanRoots: null, fakeTrashDir: null });
  });

  it('reports only missing scan roots', () => {
    const present = tempDir();
    const missing = path.join(present, 'nope');
    expect(missingScanRoots([present, missing])).toEqual([missing]);
  });

  it('moves files into the fake trash directory', async () => {
    const source = tempDir();
    const trash = path.join(tempDir(), 'trash');
    const file = path.join(source, 'duplicate-a.bin');
    fs.writeFileSync(file, 'payload');
    const trashItem = createFakeTrashItem(trash);
    await trashItem(file);
    expect(fs.existsSync(file)).toBe(false);
    const stored = fs.readdirSync(trash);
    expect(stored).toHaveLength(1);
    expect(fs.readFileSync(path.join(trash, stored[0]), 'utf8')).toBe('payload');
  });

  it('exposes an always-available recycle policy for the fake trash', () => {
    const policy = createFakeRecyclePolicy();
    expect(policy.available).toBe(true);
    expect(policy.maxCapacityBytes).toBeGreaterThan(0);
  });
});
