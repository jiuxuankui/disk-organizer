import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDED_PATHS, SYSTEM_EXCLUDED_DIR_NAMES } from '@shared/constants';
import { isSameOrSubPath, normalizePathKey } from './filesystem';
import { LONG_PATH_LIMIT } from './longTrashService';
import { readFileAttributes } from './windowsService';

export interface EmptyFolderCleanupDeps {
  trashItem(folder: string): Promise<void>;
  protectedPaths: string[];
}

export interface EmptyFolderCleanupReport {
  cleaned: string[];
  failed: Array<{ path: string; reason: string }>;
}

type FolderDecision = { action: 'clean' } | { action: 'skip' } | { action: 'fail'; reason: string };

const DRIVE_ROOT = /^[a-z]:\\?$/i;

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || '未知错误';
}

function decide(folder: string, deps: EmptyFolderCleanupDeps): FolderDecision {
  const key = normalizePathKey(folder);
  if (DRIVE_ROOT.test(key)) return { action: 'skip' };
  if (folder.length >= LONG_PATH_LIMIT) {
    return { action: 'fail', reason: '路径超过 260 字符，未自动清理' };
  }
  const segments = key.split('\\');
  if (SYSTEM_EXCLUDED_DIR_NAMES.some((name) => segments.includes(name.toLowerCase()))) {
    return { action: 'skip' };
  }
  if (
    [...DEFAULT_EXCLUDED_PATHS, ...deps.protectedPaths].some((entry) =>
      isSameOrSubPath(folder, entry),
    )
  ) {
    return { action: 'skip' };
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(folder);
  } catch {
    return { action: 'skip' };
  }
  if (stats.isSymbolicLink()) return { action: 'fail', reason: '链接或重解析点，未自动清理' };
  const attributes = readFileAttributes(folder);
  if (!attributes) return { action: 'fail', reason: '无法读取文件夹属性，未自动清理' };
  if (attributes.reparsePoint) return { action: 'fail', reason: '链接或重解析点，未自动清理' };
  if (attributes.system) return { action: 'fail', reason: '系统文件夹，未自动清理' };
  if (!stats.isDirectory()) return { action: 'skip' };
  try {
    if (fs.readdirSync(folder).length > 0) return { action: 'skip' };
  } catch {
    return { action: 'fail', reason: '无法读取文件夹内容，未自动清理' };
  }
  return { action: 'clean' };
}

export async function cleanupEmptyParents(
  parents: string[],
  deps: EmptyFolderCleanupDeps,
): Promise<EmptyFolderCleanupReport> {
  const unique = [
    ...new Map(parents.map((folder) => [normalizePathKey(folder), folder])).values(),
  ].sort((a, b) => b.length - a.length);
  const report: EmptyFolderCleanupReport = { cleaned: [], failed: [] };
  for (const start of unique) {
    let current = start;
    for (;;) {
      const decision = decide(current, deps);
      if (decision.action === 'skip') break;
      if (decision.action === 'fail') {
        report.failed.push({ path: current, reason: decision.reason });
        break;
      }
      try {
        await deps.trashItem(current);
      } catch (error) {
        report.failed.push({
          path: current,
          reason: `放入回收站失败，空文件夹已保留：${describe(error)}`,
        });
        break;
      }
      report.cleaned.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return report;
}
