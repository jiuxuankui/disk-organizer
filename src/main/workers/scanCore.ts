import type { BigIntStats, Dirent } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SkipReason, SkippedSummary } from '@shared/types';
import { SKIPPED_SAMPLE_LIMIT, SYSTEM_EXCLUDED_DIR_NAMES } from '@shared/constants';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import type { ScanCoreProgress } from './protocols';
import {
  getDriveLetter,
  getFileIdentityFromStats,
  getRootDir,
  isExcludedPath,
  isSameOrSubPath,
  normalizePathKey,
  toExtendedPath,
} from '../services/filesystem';
import { readFileAttributes, type WindowsFileAttributes } from '../services/windowsService';

export class ScanCancelledError extends Error {
  constructor() {
    super('扫描已取消');
    this.name = 'ScanCancelledError';
  }
}

export interface ScanControl {
  paused: boolean;
  cancelled: boolean;
}

export interface ScanFsOps {
  readdir(dirPath: string): Dirent[];
  lstat(filePath: string): BigIntStats | null;
  attributes(filePath: string): WindowsFileAttributes | null;
}

export const defaultScanFsOps: ScanFsOps = {
  readdir(dirPath) {
    return fs.readdirSync(toExtendedPath(dirPath), { withFileTypes: true });
  },
  lstat(filePath) {
    return fs.lstatSync(toExtendedPath(filePath), { bigint: true, throwIfNoEntry: false }) ?? null;
  },
  attributes(filePath) {
    return readFileAttributes(filePath);
  },
};

export interface ScanCoreOptions {
  scanId: number;
  drives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
  batchSize?: number;
  fsOps?: ScanFsOps;
}

export interface ScanCoreHooks {
  onPhase?(phase: 'enumerating' | 'indexing'): void;
  onProgress?(progress: ScanCoreProgress): void;
  onPaused?(): Promise<void>;
}

export interface ScanCoreResult {
  totalFiles: number;
  identifiedBytes: number;
  skipped: SkippedSummary[];
}

const SKIP_ORDER: SkipReason[] = ['excluded', 'hidden', 'system', 'permission', 'special', 'error'];

class SkipCollector {
  private readonly data = new Map<SkipReason, { count: number; samples: string[] }>();

  add(reason: SkipReason, filePath: string): void {
    const entry = this.data.get(reason) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < SKIPPED_SAMPLE_LIMIT) entry.samples.push(filePath);
    this.data.set(reason, entry);
  }

  toArray(): SkippedSummary[] {
    return SKIP_ORDER.filter((reason) => this.data.has(reason)).map((reason) => {
      const entry = this.data.get(reason)!;
      return { reason, count: entry.count, samples: [...entry.samples] };
    });
  }
}

function normalizeScanRoot(input: string): string {
  const trimmed = input.trim();
  if (/^[A-Za-z]:\\?$/.test(trimmed)) {
    return `${trimmed.charAt(0).toUpperCase()}:\\`;
  }
  return trimmed.replace(/\\+$/, '');
}

function errorReason(error: unknown): SkipReason {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission' : 'error';
}

export async function runScanCore(
  db: DatabaseSync,
  options: ScanCoreOptions,
  control: ScanControl,
  hooks: ScanCoreHooks = {},
): Promise<ScanCoreResult> {
  const fsOps = options.fsOps ?? defaultScanFsOps;
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  const skipped = new SkipCollector();
  const rules = {
    excludedPaths: options.excludedPaths,
    excludedDirNames: SYSTEM_EXCLUDED_DIR_NAMES,
  };

  let filesFound = 0;
  let filesProcessed = 0;
  let bytesProcessed = 0;
  let currentPath = '';
  let lastEmit = 0;

  function emitProgress(force = false): void {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    hooks.onProgress?.({
      phase: phase,
      filesFound,
      filesProcessed,
      bytesProcessed,
      currentPath,
    });
  }

  let phase: 'enumerating' | 'indexing' = 'enumerating';

  async function checkpoint(): Promise<void> {
    // Yield a macrotask so worker_threads can deliver pause/cancel messages.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (control.cancelled) throw new ScanCancelledError();
    if (control.paused && hooks.onPaused) {
      emitProgress(true);
      await hooks.onPaused();
      if (control.cancelled) throw new ScanCancelledError();
    }
  }

  const insertStaging = db.prepare(
    'INSERT OR IGNORE INTO scan_staging (scan_id, drive, path, path_key) VALUES (?, ?, ?, ?)',
  );

  let stagingBuffer: Array<{ drive: string; path: string; pathKey: string }> = [];

  function flushStaging(): void {
    if (stagingBuffer.length === 0) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of stagingBuffer) {
        insertStaging.run(options.scanId, item.drive, item.path, item.pathKey);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Transaction may already be rolled back.
      }
      throw error;
    }
    filesFound += stagingBuffer.length;
    stagingBuffer = [];
    emitProgress();
  }

  hooks.onPhase?.('enumerating');
  emitProgress(true);

  const scanRoots = options.drives.map(normalizeScanRoot);
  const stack = [...scanRoots].reverse();
  let entriesSinceCheckpoint = 0;

  while (stack.length > 0) {
    await checkpoint();
    const dir = stack.pop()!;
    currentPath = dir;
    let entries: Dirent[];
    try {
      entries = fsOps.readdir(dir);
    } catch (error) {
      skipped.add(errorReason(error), dir);
      emitProgress();
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.win32.join(dir, entry.name);
      entriesSinceCheckpoint += 1;
      if (entriesSinceCheckpoint % 256 === 0) {
        flushStaging();
        await checkpoint();
      }

      if (entry.isSymbolicLink()) {
        skipped.add('special', fullPath);
        continue;
      }

      const attributes = fsOps.attributes(fullPath);

      if (entry.isDirectory()) {
        if (isExcludedPath(fullPath, rules)) {
          skipped.add('excluded', fullPath);
          continue;
        }
        if (attributes?.reparsePoint) {
          skipped.add('special', fullPath);
          continue;
        }
        if (options.skipHiddenSystem && attributes?.system) {
          skipped.add('system', fullPath);
          continue;
        }
        if (options.skipHiddenSystem && attributes?.hidden) {
          skipped.add('hidden', fullPath);
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        skipped.add('special', fullPath);
        continue;
      }
      if (attributes?.reparsePoint) {
        skipped.add('special', fullPath);
        continue;
      }
      if (options.skipHiddenSystem && attributes?.system) {
        skipped.add('system', fullPath);
        continue;
      }
      if (options.skipHiddenSystem && attributes?.hidden) {
        skipped.add('hidden', fullPath);
        continue;
      }

      stagingBuffer.push({
        drive: getDriveLetter(fullPath),
        path: fullPath,
        pathKey: normalizePathKey(fullPath),
      });
      if (stagingBuffer.length >= batchSize) flushStaging();
    }
  }
  flushStaging();
  emitProgress(true);

  phase = 'indexing';
  hooks.onPhase?.('indexing');
  lastEmit = 0;
  emitProgress(true);

  const selectStaging = db.prepare(
    'SELECT path, path_key FROM scan_staging WHERE scan_id = ? AND path_key > ? ORDER BY path_key LIMIT ?',
  );
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO files
      (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let lastKey = '';
  for (;;) {
    await checkpoint();
    const rows = selectStaging.all(options.scanId, lastKey, batchSize) as Array<{
      path: string;
      path_key: string;
    }>;
    if (rows.length === 0) break;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        lastKey = row.path_key;
        currentPath = row.path;
        const stats = fsOps.lstat(row.path);
        if (!stats) {
          skipped.add('error', row.path);
          continue;
        }
        if (!stats.isFile()) {
          skipped.add('special', row.path);
          continue;
        }
        const attributes = fsOps.attributes(row.path);
        if (!attributes) {
          skipped.add('permission', row.path);
          continue;
        }
        if (attributes.reparsePoint) {
          skipped.add('special', row.path);
          continue;
        }
        if (options.skipHiddenSystem && attributes.system) {
          skipped.add('system', row.path);
          continue;
        }
        if (options.skipHiddenSystem && attributes.hidden) {
          skipped.add('hidden', row.path);
          continue;
        }
        if (attributes.directory) {
          skipped.add('special', row.path);
          continue;
        }

        const name = path.win32.basename(row.path);
        const drive = getDriveLetter(row.path);
        const dirPath = path.win32.dirname(row.path);
        const identity = getFileIdentityFromStats(stats);
        const size = Number(stats.size);
        const scanRoot = scanRoots.find((root) => isSameOrSubPath(row.path, root)) ?? `${drive}\\`;
        const rootDir = getRootDir(
          row.path,
          scanRoot.endsWith('\\') ? scanRoot : `${scanRoot}\\`,
        );
        insertFile.run(
          options.scanId,
          drive,
          row.path,
          row.path_key,
          name,
          name.toLowerCase(),
          getExtension(name),
          classifyFileName(name),
          size,
          Number(stats.mtimeMs),
          Number(stats.ctimeMs),
          rootDir,
          dirPath,
          normalizePathKey(dirPath),
          identity?.volumeId ?? '',
          identity?.fileId ?? '',
        );
        filesProcessed += 1;
        bytesProcessed += size;
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Transaction may already be rolled back.
      }
      throw error;
    }
    emitProgress();
    await checkpoint();
  }

  const totals = db
    .prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM files WHERE scan_id = ?',
    )
    .get(options.scanId) as { total: number; bytes: number };

  emitProgress(true);
  return {
    totalFiles: totals.total,
    identifiedBytes: totals.bytes,
    skipped: skipped.toArray(),
  };
}
