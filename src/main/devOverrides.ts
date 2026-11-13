import fs from 'node:fs';
import path from 'node:path';
import type { RecycleBinPolicy } from './services/recycleBinService';

export interface DevOverrides {
  scanRoots: string[] | null;
  fakeTrashDir: string | null;
}

export function readDevOverrides(env: NodeJS.ProcessEnv = process.env): DevOverrides {
  const scanRoots = (env.DISK_ORGANIZER_SCAN_ROOTS ?? '')
    .split(';')
    .map((root) => root.trim())
    .filter(Boolean);
  const fakeTrashDir = env.DISK_ORGANIZER_FAKE_TRASH_DIR?.trim() || null;
  return {
    scanRoots: scanRoots.length > 0 ? scanRoots : null,
    fakeTrashDir,
  };
}

export function missingScanRoots(roots: string[]): string[] {
  return roots.filter((root) => {
    try {
      return !fs.statSync(root).isDirectory();
    } catch {
      return true;
    }
  });
}

export function createFakeRecyclePolicy(): RecycleBinPolicy {
  return {
    available: true,
    blockReason: null,
    volumeGuid: null,
    noRecycleFiles: false,
    nukeOnDelete: false,
    configuredMaxCapacityMB: null,
    maxCapacityBytes: Number.MAX_SAFE_INTEGER,
    defaultCapacityUsed: false,
  };
}

let fakeTrashSequence = 0;

export function createFakeTrashItem(dir: string): (filePath: string) => Promise<void> {
  const targetDir = path.resolve(dir);
  return async (filePath) => {
    await fs.promises.mkdir(targetDir, { recursive: true });
    fakeTrashSequence += 1;
    const target = path.join(
      targetDir,
      `${Date.now()}-${fakeTrashSequence}-${path.basename(filePath)}`,
    );
    try {
      await fs.promises.rename(filePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.promises.copyFile(filePath, target);
      await fs.promises.unlink(filePath);
    }
  };
}
