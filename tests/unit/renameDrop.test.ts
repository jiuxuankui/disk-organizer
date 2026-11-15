import { describe, expect, it } from 'vitest';
import { collectDroppedPaths, hasFileDrag } from '../../src/renderer/lib/renameDrop';

function fakeFiles(paths: Array<string | null>): File[] {
  return paths.map((path) => ({ path }) as unknown as File);
}

describe('批量重命名拖入辅助', () => {
  it('提取路径并按大小写无关去重，跳过空路径', () => {
    const files = fakeFiles([
      'C:\\Data\\a.txt',
      'c:/data/A.TXT',
      '',
      'C:\\Data\\Folder\\',
      'c:\\data\\folder',
    ]);
    const result = collectDroppedPaths(files, (file) => (file as unknown as { path: string }).path);
    expect(result).toEqual(['C:\\Data\\a.txt', 'C:\\Data\\Folder\\']);
  });

  it('读取失败的文件会被跳过', () => {
    const files = fakeFiles(['D:\\ok.txt', 'D:\\bad.txt']);
    const result = collectDroppedPaths(files, (file) => {
      const path = (file as unknown as { path: string }).path;
      if (path.endsWith('bad.txt')) throw new Error('no path');
      return path;
    });
    expect(result).toEqual(['D:\\ok.txt']);
  });

  it('识别包含文件的数据传输类型', () => {
    expect(hasFileDrag(['Files', 'text/plain'])).toBe(true);
    expect(hasFileDrag(['text/plain'])).toBe(false);
  });
});
