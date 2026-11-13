import { describe, expect, it } from 'vitest';
import {
  getDirectoryPath,
  getDriveLetter,
  getRootDir,
  isExcludedPath,
  isSameOrSubPath,
  normalizePathKey,
  stripExtendedPath,
  toExtendedPath,
} from '../../src/main/services/filesystem';

describe('path normalization', () => {
  it('builds lowercase path keys with stable slashes', () => {
    expect(normalizePathKey('C:\\Users\\Bob\\File.TXT')).toBe('c:\\users\\bob\\file.txt');
    expect(normalizePathKey('C:/Users/Bob/File.TXT')).toBe('c:\\users\\bob\\file.txt');
    expect(normalizePathKey('C:\\Users\\Bob\\')).toBe('c:\\users\\bob');
    expect(normalizePathKey('C:\\')).toBe('c:\\');
  });

  it('extracts drive letter and first-level folder', () => {
    expect(getDriveLetter('D:\\Media\\movie.mp4')).toBe('D:');
    expect(getRootDir('D:\\Media\\movie.mp4', 'D:\\')).toBe('Media');
    expect(getRootDir('D:\\movie.mp4', 'D:\\')).toBe('');
    expect(getRootDir('D:\\Media\\', 'D:\\')).toBe('Media');
    expect(getDirectoryPath('D:\\Media\\movie.mp4')).toBe('D:\\Media');
  });

  it('respects directory boundaries when testing sub paths', () => {
    expect(isSameOrSubPath('C:\\Program Files\\App\\a.exe', 'C:\\Program Files')).toBe(true);
    expect(isSameOrSubPath('C:\\Program Files', 'C:\\Program Files')).toBe(true);
    expect(isSameOrSubPath('C:\\Program Files2\\a.exe', 'C:\\Program Files')).toBe(false);
    expect(isSameOrSubPath('D:\\Program Files\\a.exe', 'C:\\Program Files')).toBe(false);
  });

  it('matches excluded paths and system directory names', () => {
    const rules = {
      excludedPaths: ['C:\\Windows', 'D:\\Private'],
      excludedDirNames: ['$Recycle.Bin', 'System Volume Information'],
    };
    expect(isExcludedPath('C:\\Windows\\System32\\a.dll', rules)).toBe(true);
    expect(isExcludedPath('d:\\private\\x.txt', rules)).toBe(true);
    expect(isExcludedPath('E:\\$RECYCLE.BIN\\S-1-5\\x', rules)).toBe(true);
    expect(isExcludedPath('E:\\Folder\\System Volume Information\\x', rules)).toBe(true);
    expect(isExcludedPath('E:\\Music\\My$Recycle.Bin\\x', rules)).toBe(false);
    expect(isExcludedPath('C:\\Users\\a.txt', rules)).toBe(false);
  });

  it('adds and strips the extended path prefix', () => {
    expect(toExtendedPath('C:\\Users\\a.txt')).toBe('\\\\?\\C:\\Users\\a.txt');
    expect(toExtendedPath('\\\\server\\share\\a.txt')).toBe('\\\\?\\UNC\\server\\share\\a.txt');
    const already = '\\\\?\\C:\\Users\\a.txt';
    expect(toExtendedPath(already)).toBe(already);
    expect(stripExtendedPath(already)).toBe('C:\\Users\\a.txt');
    expect(stripExtendedPath('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');
  });
});
