import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';

export function toExtendedPath(input: string): string {
  if (input.startsWith('\\\\?\\')) return input;
  if (input.startsWith('\\\\')) return `\\\\?\\UNC\\${input.slice(2)}`;
  if (path.win32.isAbsolute(input)) return `\\\\?\\${input}`;
  return input;
}

export function stripExtendedPath(input: string): string {
  if (input.startsWith('\\\\?\\UNC\\')) return `\\\\${input.slice(8)}`;
  if (input.startsWith('\\\\?\\')) return input.slice(4);
  return input;
}

export function normalizePathKey(input: string): string {
  let key = path.win32.normalize(input.trim());
  if (/^[a-zA-Z]:\\$/.test(key)) {
    key = key.slice(0, 2) + '\\';
  } else {
    key = key.replace(/\\+$/, '');
  }
  return key.toLowerCase();
}

export function getDriveLetter(filePath: string): string {
  const parsed = path.win32.parse(filePath);
  return parsed.root ? parsed.root.slice(0, 2).toUpperCase() : '';
}

export function getRootDir(filePath: string, driveRoot: string): string {
  const normalizedRoot = driveRoot.endsWith('\\') ? driveRoot : `${driveRoot}\\`;
  if (!filePath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return '';
  const rest = filePath.slice(normalizedRoot.length);
  const sep = rest.indexOf('\\');
  return sep >= 0 ? rest.slice(0, sep) : '';
}

export function getDirectoryPath(filePath: string): string {
  return path.win32.dirname(filePath);
}

export function isSameOrSubPath(child: string, parent: string): boolean {
  const childKey = normalizePathKey(child);
  const parentKey = normalizePathKey(parent);
  if (childKey === parentKey) return true;
  const withSep = parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`;
  return childKey.startsWith(withSep);
}

export interface ExcludedPathRules {
  excludedPaths: string[];
  excludedDirNames?: string[];
}

export function isExcludedPath(filePath: string, rules: ExcludedPathRules): boolean {
  for (const excluded of rules.excludedPaths) {
    if (excluded && isSameOrSubPath(filePath, excluded)) return true;
  }
  const dirNames = rules.excludedDirNames ?? [];
  if (dirNames.length === 0) return false;
  const lowerNames = new Set(dirNames.map((name) => name.toLowerCase()));
  for (const segment of filePath.split('\\')) {
    if (lowerNames.has(segment.toLowerCase())) return true;
  }
  return false;
}

export function isExcludedName(name: string, rules: ExcludedPathRules): boolean {
  const dirNames = rules.excludedDirNames ?? [];
  return dirNames.some((dir) => dir.toLowerCase() === name.toLowerCase());
}

export interface FileIdentity {
  volumeId: string;
  fileId: string;
}

export function getFileIdentity(filePath: string): FileIdentity | null {
  try {
    const stats = statSync(toExtendedPath(filePath), { bigint: true });
    if (stats.ino === 0n) return null;
    return {
      volumeId: stats.dev.toString(16),
      fileId: stats.ino.toString(16),
    };
  } catch {
    return null;
  }
}

export function getFileIdentityFromStats(stats: { dev: bigint; ino: bigint }): FileIdentity | null {
  if (stats.ino === 0n) return null;
  return {
    volumeId: stats.dev.toString(16),
    fileId: stats.ino.toString(16),
  };
}

export function safeLstat(filePath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(toExtendedPath(filePath), { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}
