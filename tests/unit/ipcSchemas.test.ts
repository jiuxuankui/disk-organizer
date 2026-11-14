import { describe, expect, it } from 'vitest';
import {
  copyTextSchema,
  deleteFilesSchema,
  driveQuerySchema,
  fileIdSchema,
  fileQuerySchema,
  parseIpc,
  pathSchema,
  scanStartSchema,
  settingsUpdateSchema,
} from '../../src/main/ipc/schemas';

describe('IPC validation schemas', () => {
  it('normalizes scan drive letters', () => {
    const parsed = scanStartSchema.parse({
      drives: ['c', 'D:'],
      skipHiddenSystem: false,
    });
    expect(parsed.drives).toEqual(['C:', 'D:']);
    expect(parsed.skipHiddenSystem).toBe(false);
  });

  it('rejects empty or malformed scan payloads with readable messages', () => {
    expect(() => parseIpc(scanStartSchema, { drives: [] }, '开始扫描')).toThrow(
      /开始扫描参数无效：请至少选择一块硬盘/,
    );
    expect(() => parseIpc(scanStartSchema, { drives: ['C:\\Windows'] }, '开始扫描')).toThrow(
      /硬盘格式应为 C:/,
    );
    expect(() =>
      parseIpc(scanStartSchema, { drives: ['C:'], unexpected: true }, '开始扫描'),
    ).toThrow(/参数无效/);
  });

  it('rejects oversized collections before allocating per-element validation errors', () => {
    const scan = scanStartSchema.safeParse({ drives: Array(10000).fill(null) });
    expect(scan.success).toBe(false);
    if (!scan.success) expect(scan.error.issues.map((issue) => issue.code)).toEqual(['too_big']);

    const deletion = deleteFilesSchema.safeParse({ fileIds: Array(200001).fill(null) });
    expect(deletion.success).toBe(false);
    if (!deletion.success)
      expect(deletion.error.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  it('validates file paths', () => {
    expect(pathSchema.parse({ path: 'C:\\a.txt' }).path).toBe('C:\\a.txt');
    expect(() => parseIpc(pathSchema, { path: '' }, '打开位置')).toThrow(/路径不能为空/);
    expect(() => parseIpc(pathSchema, {}, '打开位置')).toThrow(/参数无效/);
  });

  it('accepts a missing or null drive query', () => {
    expect(driveQuerySchema.parse({ drive: 'd:' }).drive).toBe('D:');
    expect(driveQuerySchema.parse({}).drive).toBeUndefined();
    expect(driveQuerySchema.parse({ drive: null }).drive).toBeNull();
    expect(() => driveQuerySchema.parse({ drive: 'not-a-drive' })).toThrow();
  });

  it('applies safe defaults to file queries', () => {
    const parsed = fileQuerySchema.parse({});
    expect(parsed).toMatchObject({
      sortBy: 'size',
      sortOrder: 'desc',
      page: 1,
      pageSize: 200,
    });
    expect(parsed.search).toBeUndefined();
    expect(parsed.drive).toBeUndefined();
  });

  it('accepts a fully specified file query and normalizes the drive', () => {
    const parsed = fileQuerySchema.parse({
      drive: 'd',
      type: 'video',
      minSize: 0,
      maxSize: 1024,
      mtimeFrom: 100,
      mtimeTo: 200,
      rootDir: 'Movies',
      dirPath: 'D:\\Movies\\Sub',
      search: 'film',
      sortBy: 'name',
      sortOrder: 'asc',
      page: 2,
      pageSize: 500,
    });
    expect(parsed.drive).toBe('D:');
    expect(parsed.type).toBe('video');
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(500);
  });

  it('rejects invalid file query values', () => {
    expect(() => fileQuerySchema.parse({ sortBy: 'path' })).toThrow();
    expect(() => fileQuerySchema.parse({ sortOrder: 'up' })).toThrow();
    expect(() => fileQuerySchema.parse({ page: 0 })).toThrow();
    expect(() => fileQuerySchema.parse({ pageSize: 5000 })).toThrow();
    expect(() => fileQuerySchema.parse({ minSize: -1 })).toThrow();
    expect(() => fileQuerySchema.parse({ drive: 'C:\\Windows' })).toThrow();
    expect(() => fileQuerySchema.parse({ type: 'spreadsheet' })).toThrow();
    expect(() => fileQuerySchema.parse({ unexpected: true })).toThrow();
    expect(() => parseIpc(fileQuerySchema, { page: -2 }, '文件查询')).toThrow(/文件查询参数无效/);
  });

  it('validates file ids and copied text', () => {
    expect(fileIdSchema.parse({ id: 12 }).id).toBe(12);
    expect(() => fileIdSchema.parse({ id: 0 })).toThrow();
    expect(() => fileIdSchema.parse({ id: 1.5 })).toThrow();
    expect(copyTextSchema.parse({ text: 'C:\\a.txt' }).text).toBe('C:\\a.txt');
    expect(() => copyTextSchema.parse({ text: '' })).toThrow();
  });

  it('validates delete payloads', () => {
    expect(deleteFilesSchema.parse({ fileIds: [1, 2, 2] }).fileIds).toEqual([1, 2, 2]);
    expect(() => parseIpc(deleteFilesSchema, { fileIds: [] }, '删除预览')).toThrow(
      /至少选择一个文件/,
    );
    expect(() => deleteFilesSchema.parse({ fileIds: [0] })).toThrow();
    expect(() => deleteFilesSchema.parse({ fileIds: [1.5] })).toThrow();
    expect(() => deleteFilesSchema.parse({ fileIds: [1], extra: true })).toThrow();
    expect(() => deleteFilesSchema.parse({ fileIds: ['1'] })).toThrow();
  });

  it('validates settings updates', () => {
    expect(
      settingsUpdateSchema.parse({
        scanDrives: ['c', 'D:'],
        skipHiddenSystem: false,
        autoBackup: false,
      }),
    ).toMatchObject({
      scanDrives: ['C:', 'D:'],
      skipHiddenSystem: false,
      autoBackup: false,
    });
    expect(settingsUpdateSchema.parse({ excludedPaths: ['D:\\Temp'] }).excludedPaths).toEqual([
      'D:\\Temp',
    ]);
    expect(() => parseIpc(settingsUpdateSchema, {}, '保存设置')).toThrow(/没有需要保存的设置/);
    expect(() => settingsUpdateSchema.parse({ unknown: 1 })).toThrow();
    expect(() => settingsUpdateSchema.parse({ excludedPaths: [''] })).toThrow();
    expect(() => settingsUpdateSchema.parse({ scanDrives: ['C:\\Windows'] })).toThrow();
  });
});
