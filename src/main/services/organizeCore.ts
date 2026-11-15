import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileRecord } from '@shared/types';
import {
  localOrganizePath,
  type OrganizeNamePatternMode,
  type OrganizePriority,
  type OrganizeRule,
} from '@shared/organize';
import { DEFAULT_EXCLUDED_PATHS, SYSTEM_EXCLUDED_DIR_NAMES } from '@shared/constants';
import { getDriveLetter, isSameOrSubPath, normalizePathKey } from './filesystem';
import { moveFileNoReplace, readFileAttributes } from './windowsService';

const DASH_VARIANTS = /[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFF0D]/g;
const patternCache = new Map<string, RegExp | null>();

function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(DASH_VARIANTS, '-');
}

export function compileNamePattern(
  pattern: string,
  mode: OrganizeNamePatternMode = 'exact',
): RegExp | null {
  const key = pattern.trim();
  if (key === '') return null;
  const cacheKey = `${mode}\u0000${key}`;
  const cached = patternCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let source = '';
  for (const character of normalizeForMatch(key)) {
    source += character === 'x' ? '.' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(mode === 'contains' ? source : `^${source}$`, 'u');
  } catch {
    compiled = null;
  }
  if (patternCache.size >= 500) patternCache.clear();
  patternCache.set(cacheKey, compiled);
  return compiled;
}

export function namePatternMatches(name: string, pattern: RegExp): boolean {
  let stem = path.parse(name).name;
  for (let depth = 0; depth < 4; depth += 1) {
    if (pattern.test(normalizeForMatch(stem))) return true;
    const next = path.parse(stem).name;
    if (next === stem || next === '') return false;
    stem = next;
  }
  return false;
}

export function ruleMatchesFile(file: FileRecord, rule: OrganizeRule): boolean {
  const tests: Array<() => boolean> = [];
  if (rule.type !== 'all') tests.push(() => rule.type === file.type);
  if (rule.extensions.length > 0)
    tests.push(() => rule.extensions.includes(file.ext.toLowerCase()));
  if (rule.nameContains.trim() !== '')
    tests.push(() => file.name.toLowerCase().includes(rule.nameContains.trim().toLowerCase()));
  if (rule.namePattern.trim() !== '') {
    const pattern = compileNamePattern(rule.namePattern, rule.namePatternMode);
    if (pattern) tests.push(() => namePatternMatches(file.name, pattern));
  }
  if (rule.minSize !== null || rule.maxSize !== null) {
    const { minSize, maxSize } = rule;
    tests.push(
      () =>
        (minSize === null || file.size >= minSize) && (maxSize === null || file.size <= maxSize),
    );
  }
  if (rule.mtimeFrom !== null || rule.mtimeTo !== null) {
    const { mtimeFrom, mtimeTo } = rule;
    tests.push(
      () =>
        (mtimeFrom === null || file.mtimeMs >= mtimeFrom) &&
        (mtimeTo === null || file.mtimeMs <= mtimeTo),
    );
  }
  if (rule.pathContains.trim() !== '')
    tests.push(() => file.path.toLowerCase().includes(rule.pathContains.trim().toLowerCase()));
  if (tests.length === 0) return true;
  return rule.matchMode === 'any' ? tests.some((test) => test()) : tests.every((test) => test());
}

export function chooseOrganizeRule(
  file: FileRecord,
  rules: OrganizeRule[],
  priority: OrganizePriority = 'sameDrive',
): OrganizeRule | undefined {
  const matches = rules.filter((rule) => rule.enabled && ruleMatchesFile(file, rule));
  if (priority === 'order') return matches[0];
  return matches.find((rule) => getDriveLetter(rule.targetDir) === file.drive) ?? matches[0];
}

export type OrganizePathKind = 'file' | 'directory';

export function organizeAttributeError(
  kind: OrganizePathKind,
  attributes: { system: boolean; reparsePoint: boolean } | null,
): string | null {
  if (!attributes) return '无法读取文件或文件夹属性';
  if (attributes.reparsePoint) return '不能整理链接或重解析点';
  if (kind === 'file' && attributes.system) return '不能整理系统文件';
  return null;
}

export function organizeLocalPath(
  value: string,
  drives: Set<string>,
  protectedPaths: string[],
  kind: OrganizePathKind = 'file',
): string {
  localOrganizePath.parse(value);
  if (!drives.has(getDriveLetter(value))) throw new Error('只支持可用的本地固定硬盘');
  const resolved = fs.realpathSync(value);
  if (normalizePathKey(resolved) !== normalizePathKey(value))
    throw new Error('整理不支持链接或重定向路径');
  const blocked = [...DEFAULT_EXCLUDED_PATHS, ...protectedPaths];
  const segments = resolved.split(/[\\/]/).map((part) => part.toLowerCase());
  if (
    blocked.some((entry) => isSameOrSubPath(resolved, entry)) ||
    SYSTEM_EXCLUDED_DIR_NAMES.some((name) => segments.includes(name.toLowerCase()))
  ) {
    throw new Error('系统目录、软件目录或回收区不能参与整理');
  }
  const message = organizeAttributeError(kind, readFileAttributes(resolved));
  if (message) throw new Error(message);
  return resolved;
}

export function assertUnchanged(file: string, before: fs.Stats): void {
  const after = fs.lstatSync(file);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino ||
    after.dev !== before.dev
  ) {
    throw new Error('文件已变化，请重新预览');
  }
}

export async function copyVerifiedForMove(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const directory = path.dirname(target);
  const parent = fs.statSync(directory);
  const before = fs.statSync(source);
  const work = await fs.promises.mkdtemp(path.join(directory, '.disk-organizer-move-'));
  let published = false;
  let failure: unknown = null;
  try {
    const temp = path.join(work, 'copy');
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      fs.createReadStream(source),
      hashing,
      fs.createWriteStream(temp, { flags: 'wx' }),
      { signal },
    );
    const expected = hash.digest('hex');
    const check = createHash('sha256');
    for await (const chunk of fs.createReadStream(temp, { signal })) check.update(chunk);
    if (check.digest('hex') !== expected) throw new Error('跨盘副本校验失败，原件保留');
    const fd = await fs.promises.open(temp, 'r+');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.promises.utimes(temp, before.atime, before.mtime);
    signal.throwIfAborted();
    assertUnchanged(source, before);
    if (normalizePathKey(fs.realpathSync(directory)) !== normalizePathKey(directory))
      throw new Error('目标目录已重定向');
    const currentParent = fs.statSync(directory);
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino)
      throw new Error('目标目录已变化');
    moveFileNoReplace(temp, target);
    published = true;
  } catch (error) {
    failure = error;
  }
  try {
    await fs.promises.rm(work, { recursive: true, force: true });
  } catch {
    const reason = failure instanceof Error ? `${failure.message}；` : '';
    failure = new Error(
      `${reason}${published ? `副本已保留在 ${target}；` : ''}临时目录未能清理：${work}`,
    );
  }
  if (failure) throw failure;
}
