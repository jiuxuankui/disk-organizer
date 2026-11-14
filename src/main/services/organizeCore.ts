import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileRecord } from '@shared/types';
import { localOrganizePath, type OrganizePriority, type OrganizeRule } from '@shared/organize';
import { DEFAULT_EXCLUDED_PATHS, SYSTEM_EXCLUDED_DIR_NAMES } from '@shared/constants';
import { getDriveLetter, isSameOrSubPath, normalizePathKey } from './filesystem';
import { moveFileNoReplace, readFileAttributes } from './windowsService';

export function chooseOrganizeRule(
  file: FileRecord,
  rules: OrganizeRule[],
  priority: OrganizePriority = 'sameDrive',
): OrganizeRule | undefined {
  const matches = rules.filter(
    (rule) =>
      rule.enabled &&
      (rule.type === 'all' || rule.type === file.type) &&
      (rule.extensions.length === 0 || rule.extensions.includes(file.ext.toLowerCase())) &&
      file.name.toLowerCase().includes(rule.nameContains.toLowerCase()),
  );
  if (priority === 'order') return matches[0];
  return matches.find((rule) => getDriveLetter(rule.targetDir) === file.drive) ?? matches[0];
}

export function organizeLocalPath(
  value: string,
  drives: Set<string>,
  protectedPaths: string[],
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
  const attributes = readFileAttributes(resolved);
  if (!attributes || attributes.reparsePoint || attributes.system)
    throw new Error('不能整理系统文件或重解析点');
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
