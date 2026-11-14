import { describe, expect, it } from 'vitest';
import { archiveEntryName } from '../../src/main/services/archiveService';
import { archiveStartSchema } from '../../src/main/ipc/schemas';

describe('archive safety boundaries', () => {
  it('uses relative drive-prefixed entry names to avoid collisions and traversal', () => {
    expect(archiveEntryName('C:\\docs\\同名.txt')).toBe('C/docs/同名.txt');
    expect(archiveEntryName('D:\\docs\\同名.txt')).toBe('D/docs/同名.txt');
    for (const value of ['../a', 'C:\\a\\..\\b', 'C:\\a:stream', '\\\\server\\a', 'C:\\a\0']) {
      expect(() => archiveEntryName(value)).toThrow();
    }
  });

  it('limits selection, output names and compression formats at IPC', () => {
    const input = { fileIds: [1, 2], outputDir: 'D:\\archives', name: '文件打包', format: 'zip' };
    expect(archiveStartSchema.safeParse(input).success).toBe(true);
    expect(archiveStartSchema.safeParse({ ...input, format: 'tar.gz' }).success).toBe(true);
    for (const patch of [
      { fileIds: [] },
      { fileIds: [-1] },
      { fileIds: Array.from({ length: 10001 }, (_, i) => i + 1) },
      { format: 'rar' },
      { name: '../overwrite' },
      { name: 'a\\b' },
      { name: 'a:stream' },
      { name: 'CON' },
      { name: 'NUL.txt' },
      { name: 'a.' },
      { name: '\0bad' },
      { executable: 'cmd.exe' },
    ]) {
      expect(
        archiveStartSchema.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});
