import { describe, expect, it } from 'vitest';
import {
  applyRenameRules,
  createRenameRule,
  validateRenameName,
  type RenameRule,
} from '@shared/rename';

function rule<T extends RenameRule['type']>(
  type: T,
  patch: Partial<Extract<RenameRule, { type: T }>> = {},
): Extract<RenameRule, { type: T }> {
  return { ...createRenameRule(type), ...patch } as Extract<RenameRule, { type: T }>;
}

const context = { index: 1, now: new Date(2024, 0, 31, 23, 59, 59).valueOf(), mtimeMs: 0 };

describe('批量重命名规则引擎', () => {
  it('文件只处理扩展名之前的部分，并保留扩展名', () => {
    const result = applyRenameRules(
      'My Report.txt',
      'file',
      [rule('findReplace', { find: 'report', replace: 'summary' })],
      context,
    );
    expect(result.name).toBe('My summary.txt');
  });

  it('查找替换支持不区分大小写、只替换第一处和正则表达式', () => {
    expect(
      applyRenameRules(
        'Ab ab AB.txt',
        'file',
        [rule('findReplace', { find: 'ab', replace: 'x', replaceAll: false })],
        context,
      ).name,
    ).toBe('x ab AB.txt');
    expect(
      applyRenameRules(
        'Ab ab AB.txt',
        'file',
        [rule('findReplace', { find: 'ab', replace: 'x' })],
        context,
      ).name,
    ).toBe('x x x.txt');
    expect(
      applyRenameRules(
        'IMG_2024_001.jpg',
        'file',
        [
          rule('findReplace', {
            find: '(\\d{4})_(\\d+)',
            replace: '$2-$1',
            useRegex: true,
          }),
        ],
        context,
      ).name,
    ).toBe('IMG_001-2024.jpg');
    expect(
      applyRenameRules(
        'Report-REPORT.txt',
        'file',
        [rule('findReplace', { find: 'report', replace: 'doc', useRegex: true })],
        context,
      ).name,
    ).toBe('doc-doc.txt');
    expect(
      applyRenameRules(
        'Report-REPORT.txt',
        'file',
        [rule('findReplace', { find: 'REPORT', replace: 'doc', useRegex: true, caseSensitive: true })],
        context,
      ).name,
    ).toBe('Report-doc.txt');
    expect(() =>
      applyRenameRules(
        'a.txt',
        'file',
        [rule('findReplace', { find: '(', replace: '', useRegex: true })],
        context,
      ),
    ).toThrow(/正则表达式无效/);
  });

  it('前后缀、按位置删除和按位置插入按顺序执行', () => {
    const rules: RenameRule[] = [
      rule('prefixSuffix', { prefix: '[', suffix: ']' }),
      rule('deleteRange', { start: 2, count: 2 }),
      rule('insertAt', { position: 2, text: 'XY' }),
    ];
    expect(applyRenameRules('abcdef', 'folder', rules, context).name).toBe('[XYcdef]');
  });

  it('序号支持起始值、步长、位数、分隔符和位置', () => {
    expect(
      applyRenameRules(
        'photo.jpg',
        'file',
        [
          rule('numbering', {
            start: 8,
            step: 2,
            padding: 4,
            position: 'suffix',
            separator: '_',
          }),
        ],
        { ...context, index: 2 },
      ).name,
    ).toBe('photo_0010.jpg');
    expect(
      applyRenameRules(
        'photo.jpg',
        'file',
        [rule('numbering', { start: 1, step: 1, padding: 2, position: 'prefix', separator: '-' })],
        context,
      ).name,
    ).toBe('01-photo.jpg');
    expect(
      applyRenameRules(
        'photo.jpg',
        'file',
        [rule('numbering', { position: 'replace', padding: 3, separator: '' })],
        context,
      ).name,
    ).toBe('001.jpg');
  });

  it('大小写转换覆盖四种模式', () => {
    expect(
      applyRenameRules('Abc DEF', 'folder', [rule('case', { mode: 'upper' })], context).name,
    ).toBe('ABC DEF');
    expect(
      applyRenameRules('Abc DEF', 'folder', [rule('case', { mode: 'lower' })], context).name,
    ).toBe('abc def');
    expect(
      applyRenameRules('abc DEF', 'folder', [rule('case', { mode: 'capitalize' })], context).name,
    ).toBe('Abc DEF');
    expect(
      applyRenameRules('abc-def ghi', 'folder', [rule('case', { mode: 'title' })], context).name,
    ).toBe('Abc-Def Ghi');
  });

  it('扩展名规则只对文件生效，留空去掉扩展名', () => {
    expect(
      applyRenameRules('photo.jpg', 'file', [rule('extension', { extension: '.PNG' })], context)
        .name,
    ).toBe('photo.PNG');
    expect(
      applyRenameRules('photo.jpg', 'file', [rule('extension', { extension: '' })], context).name,
    ).toBe('photo');
    expect(
      applyRenameRules('photo.jpg', 'folder', [rule('extension', { extension: 'png' })], context)
        .name,
    ).toBe('photo.jpg');
  });

  it('按修改时间或当前日期插入日期', () => {
    const mtime = new Date(2023, 5, 7, 8, 9, 10).valueOf();
    expect(
      applyRenameRules(
        'note.txt',
        'file',
        [rule('date', { source: 'mtime', format: 'YYYY-MM-DD', position: 'prefix' })],
        { ...context, mtimeMs: mtime },
      ).name,
    ).toBe('2023-06-07note.txt');
    expect(
      applyRenameRules(
        'note.txt',
        'file',
        [rule('date', { source: 'now', format: 'YYYY年MM月DD日', position: 'suffix' })],
        context,
      ).name,
    ).toBe('note2024年01月31日.txt');
  });

  it('删除标记之前保留标记之后，删除标记之后保留标记之前', () => {
    const beforeWithMarker = applyRenameRules(
      '电影-2024-高清.mkv',
      'file',
      [
        rule('deleteMarker', {
          marker: '2024',
          direction: 'before',
          includeMarker: true,
        }),
      ],
      context,
    );
    expect(beforeWithMarker.name).toBe('-高清.mkv');

    const beforeWithoutMarker = applyRenameRules(
      '电影-2024-高清.mkv',
      'file',
      [
        rule('deleteMarker', {
          marker: '-2024',
          direction: 'before',
          includeMarker: false,
        }),
      ],
      context,
    );
    expect(beforeWithoutMarker.name).toBe('-2024-高清.mkv');

    const afterWithMarker = applyRenameRules(
      '电影-2024-高清.mkv',
      'file',
      [
        rule('deleteMarker', {
          marker: '-2024',
          direction: 'after',
          includeMarker: true,
        }),
      ],
      context,
    );
    expect(afterWithMarker.name).toBe('电影.mkv');

    const afterWithoutMarker = applyRenameRules(
      '电影-2024-高清.mkv',
      'file',
      [
        rule('deleteMarker', {
          marker: '-2024',
          direction: 'after',
          includeMarker: false,
        }),
      ],
      context,
    );
    expect(afterWithoutMarker.name).toBe('电影-2024.mkv');
  });

  it('删除标记支持第一个/最后一个、区分大小写与未找到提示', () => {
    const rules: RenameRule[] = [
      rule('deleteMarker', {
        marker: 'x',
        direction: 'after',
        includeMarker: true,
        occurrence: 'last',
      }),
    ];
    expect(applyRenameRules('aXbxc', 'folder', rules, context).name).toBe('aXb');
    const sensitive = applyRenameRules(
      'aXbxc',
      'folder',
      [rule('deleteMarker', { marker: 'X', direction: 'before', caseSensitive: true })],
      context,
    );
    expect(sensitive.name).toBe('Xbxc');
    const missing = applyRenameRules(
      'abc',
      'folder',
      [rule('deleteMarker', { marker: '不存在' })],
      context,
    );
    expect(missing.name).toBe('abc');
    expect(missing.notes).toContain('未找到标记');
  });

  it('中间步骤为空时允许后续规则补回名称', () => {
    const result = applyRenameRules(
      'abc',
      'folder',
      [
        rule('deleteRange', { start: 1, count: 3 }),
        rule('prefixSuffix', { prefix: '恢复' }),
      ],
      context,
    );
    expect(result.name).toBe('恢复');
  });

  it('校验 Windows 名称规则', () => {
    expect(validateRenameName('正常名称.txt')).toBeNull();
    expect(validateRenameName('')).toMatch(/为空/);
    expect(validateRenameName('a:b.txt')).toMatch(/不允许/);
    expect(validateRenameName('name.')).toMatch(/结尾/);
    expect(validateRenameName('CON.txt')).toMatch(/保留/);
    expect(validateRenameName('a'.repeat(256))).toMatch(/255/);
  });
});
