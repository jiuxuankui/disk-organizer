import { describe, expect, it } from 'vitest';
import type { FileRecord } from '@shared/types';
import {
  organizePreviewSchema,
  organizeRuleSchema,
  organizeRulesSchema,
  organizeStartSchema,
  smartCategoryOf,
  smartOrganizePreviewSchema,
  type OrganizeRule,
} from '@shared/organize';
import { chooseOrganizeRule, ruleMatchesFile } from '../../src/main/services/organizeCore';

const MB = 1024 * 1024;

const rule: OrganizeRule = {
  id: 'dbb71d18-ab33-4a49-97ae-fcd4b035720b',
  name: '报告',
  enabled: true,
  type: 'document',
  extensions: ['pdf'],
  nameContains: 'report',
  namePattern: '',
  targetDir: 'D:\\文档',
  minSize: null,
  maxSize: null,
  mtimeFrom: null,
  mtimeTo: null,
  pathContains: '',
  matchMode: 'all',
};
const file = { drive: 'C:', name: 'REPORT.PDF', ext: 'pdf', type: 'document' } as FileRecord;
const sizedFile = {
  drive: 'C:',
  name: 'report.pdf',
  ext: 'pdf',
  type: 'document',
  size: 5 * 1024 * 1024,
  mtimeMs: 1_700_000_000_000,
  path: 'C:\\工作\\报告\\report.pdf',
} as FileRecord;

describe('organize rules and IPC boundary', () => {
  it('normalizes extensions and rejects invalid paths, duplicate ids and oversized rule sets', () => {
    expect(
      organizeRulesSchema.parse([{ ...rule, extensions: ['.PDF', ' txt '] }])[0].extensions,
    ).toEqual(['pdf', 'txt']);
    expect(organizeRulesSchema.safeParse([rule, rule]).success).toBe(false);
    expect(organizeRulesSchema.safeParse(Array(51).fill(rule)).success).toBe(false);
    for (const targetDir of ['relative', '\\\\server\\share', 'C:\\file:stream', 'C:\\a\0b']) {
      expect(organizeRulesSchema.safeParse([{ ...rule, targetDir }]).success).toBe(false);
    }
    expect(
      organizePreviewSchema.safeParse({ sourceDir: 'C:\\docs', rules: [rule], moveNow: true })
        .success,
    ).toBe(false);
  });
  it('requires explicit cross-drive confirmation data and bounded selected ids', () => {
    const input = { token: rule.id, fileIds: [1], confirmCrossDrive: false };
    expect(organizeStartSchema.parse(input)).toEqual(input);
    expect(organizeStartSchema.safeParse({ token: rule.id, fileIds: [1] }).success).toBe(false);
    expect(organizeStartSchema.safeParse({ ...input, fileIds: [] }).success).toBe(false);
    expect(organizeStartSchema.safeParse({ ...input, fileIds: Array(10001).fill(1) }).success).toBe(
      false,
    );
    expect(organizeStartSchema.safeParse({ ...input, target: 'D:\\unsafe' }).success).toBe(false);
  });
  it('combines conditions, prefers same-drive rules and preserves order within that drive', () => {
    const local = { ...rule, name: '同盘', targetDir: 'C:\\归类' };
    expect(chooseOrganizeRule(file, [rule, local])).toBe(local);
    expect(chooseOrganizeRule(file, [rule])).toBe(rule);
    expect(chooseOrganizeRule(file, [{ ...rule, enabled: false }])).toBeUndefined();
    for (const patch of [
      { type: 'video' as const },
      { extensions: ['txt'] },
      { nameContains: 'no-match' },
    ]) {
      expect(chooseOrganizeRule(file, [{ ...rule, ...patch }])).toBeUndefined();
    }
    expect(
      chooseOrganizeRule(file, [{ ...rule, type: 'all', extensions: [], nameContains: '' }]),
    ).toBeDefined();
  });

  it('picks the first matching rule for order priority and same-drive for sameDrive', () => {
    const local = { ...rule, name: '同盘', targetDir: 'C:\\归类' };
    expect(chooseOrganizeRule(file, [rule, local], 'order')).toBe(rule);
    expect(chooseOrganizeRule(file, [local, rule], 'order')).toBe(local);
    expect(chooseOrganizeRule(file, [rule, local], 'sameDrive')).toBe(local);
    expect(chooseOrganizeRule(file, [local, rule], 'sameDrive')).toBe(local);
    expect(chooseOrganizeRule(file, [rule], 'order')).toBe(rule);
  });

  it('validates preview priority through the IPC boundary', () => {
    expect(
      organizePreviewSchema.parse({ sourceDir: 'C:\\docs', rules: [rule], priority: 'order' })
        .priority,
    ).toBe('order');
    expect(
      organizePreviewSchema.safeParse({
        sourceDir: 'C:\\docs',
        rules: [rule],
        priority: 'order',
      }).success,
    ).toBe(true);
    expect(
      organizePreviewSchema.safeParse({ sourceDir: 'C:\\docs', rules: [rule], priority: 'bad' })
        .success,
    ).toBe(false);
    expect(organizePreviewSchema.safeParse({ sourceDir: 'C:\\docs', rules: [rule] }).success).toBe(
      false,
    );
  });

  it('matches size, time and path conditions individually and via all/any', () => {
    const base: OrganizeRule = {
      ...rule,
      type: 'all',
      extensions: [],
      nameContains: '',
      namePattern: '',
      targetDir: 'C:\\归类',
    };
    expect(ruleMatchesFile(sizedFile, { ...base, minSize: 1 * MB, maxSize: 10 * MB })).toBe(true);
    expect(ruleMatchesFile(sizedFile, { ...base, minSize: 10 * MB })).toBe(false);
    expect(ruleMatchesFile(sizedFile, { ...base, maxSize: 1 * MB })).toBe(false);
    expect(
      ruleMatchesFile(sizedFile, {
        ...base,
        mtimeFrom: 1_699_000_000_000,
        mtimeTo: 1_701_000_000_000,
      }),
    ).toBe(true);
    expect(ruleMatchesFile(sizedFile, { ...base, mtimeFrom: 1_701_000_000_000 })).toBe(false);
    expect(ruleMatchesFile(sizedFile, { ...base, pathContains: '报告' })).toBe(true);
    expect(ruleMatchesFile(sizedFile, { ...base, pathContains: '不存在' })).toBe(false);

    expect(ruleMatchesFile(sizedFile, { ...base, minSize: 10 * MB, pathContains: '报告' })).toBe(
      false,
    );
    expect(
      ruleMatchesFile(sizedFile, {
        ...base,
        matchMode: 'any',
        minSize: 10 * MB,
        pathContains: '报告',
      }),
    ).toBe(true);
    expect(
      ruleMatchesFile(sizedFile, {
        ...base,
        matchMode: 'any',
        minSize: 10 * MB,
        pathContains: '不存在',
      }),
    ).toBe(false);
    expect(ruleMatchesFile(sizedFile, { ...base, matchMode: 'any' })).toBe(true);
    expect(ruleMatchesFile(sizedFile, base)).toBe(true);
  });

  it('matches filename patterns with X as any character and tolerant symbols', () => {
    const base: OrganizeRule = {
      ...rule,
      type: 'all',
      extensions: [],
      nameContains: '',
      targetDir: 'C:\\归类',
    };
    const matches = (name: string, namePattern: string): boolean =>
      ruleMatchesFile({ ...sizedFile, name }, { ...base, namePattern });

    for (const name of ['AB-123.pdf', '空调-说明书.docx']) {
      expect(matches(name, 'XX-XXX')).toBe(true);
    }
    for (const name of ['AB-1234.pdf', 'AB-123-备份.pdf', '我AB-123.pdf', 'AB-12.pdf']) {
      expect(matches(name, 'XX-XXX')).toBe(false);
    }

    expect(matches('空调1-说明书.docx', 'XXX-XXX')).toBe(true);
    expect(matches('ABC-123.pdf', 'XXX-XXX')).toBe(true);
    expect(matches('AB-123.pdf', 'XXX-XXX')).toBe(false);
    expect(matches('A_2024.pdf', 'X_XXXX')).toBe(true);
    expect(matches('A-2024.pdf', 'X_XXXX')).toBe(false);
    expect(matches('2024.pdf', 'XXXX')).toBe(true);
    expect(matches('报告合集.pdf', 'XXXX')).toBe(true);
    expect(matches('AB-123.pdf', 'XXXX')).toBe(false);
    expect(matches('AB--12.pdf', 'XX--XX')).toBe(true);
    expect(matches('AB-12.pdf', 'XX--XX')).toBe(false);

    expect(matches('ab-123.pdf', 'AB-123')).toBe(true);
    expect(matches('ＡＢ-１２３.pdf', 'XX-XXX')).toBe(true);
    expect(matches('AB－123.pdf', 'XX-XXX')).toBe(true);
    expect(matches('AB–123.pdf', 'XX-XXX')).toBe(true);
    expect(matches('AB—123.pdf', 'XX-XXX')).toBe(true);
    expect(matches('AB_123.pdf', 'XX-XXX')).toBe(false);

    expect(matches('AB-123.tar.gz', 'XX-XXX')).toBe(true);
    expect(matches('AB-1234.tar.gz', 'XX-XXX')).toBe(false);

    expect(matches('任意名字', '')).toBe(true);
    expect(matches('AB-1234.pdf', '')).toBe(true);

    expect(
      ruleMatchesFile(
        { ...sizedFile, name: 'AB-123.pdf' },
        { ...base, type: 'video', namePattern: 'XX-XXX' },
      ),
    ).toBe(false);
    expect(
      ruleMatchesFile(
        { ...sizedFile, name: 'AB-123.pdf' },
        { ...base, type: 'video', namePattern: 'XX-XXX', matchMode: 'any' },
      ),
    ).toBe(true);
  });

  it('fills defaults for legacy rules and rejects invalid ranges', () => {
    const parsed = organizeRuleSchema.parse({
      id: rule.id,
      name: '旧规则',
      enabled: true,
      type: 'document',
      extensions: [],
      nameContains: '',
      targetDir: 'D:\\文档',
    });
    expect(parsed.minSize).toBeNull();
    expect(parsed.maxSize).toBeNull();
    expect(parsed.mtimeFrom).toBeNull();
    expect(parsed.mtimeTo).toBeNull();
    expect(parsed.pathContains).toBe('');
    expect(parsed.namePattern).toBe('');
    expect(parsed.matchMode).toBe('all');

    expect(organizeRuleSchema.safeParse({ ...rule, minSize: 20, maxSize: 10 }).success).toBe(false);
    expect(organizeRuleSchema.safeParse({ ...rule, mtimeFrom: 200, mtimeTo: 100 }).success).toBe(
      false,
    );
    expect(organizeRuleSchema.safeParse({ ...rule, matchMode: 'neither' }).success).toBe(false);
    expect(organizeRuleSchema.parse({ ...rule, namePattern: '  XX-XXX  ' }).namePattern).toBe(
      'XX-XXX',
    );
    expect(organizeRuleSchema.safeParse({ ...rule, namePattern: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('maps file types to smart categories and validates smart preview input', () => {
    expect(smartCategoryOf('video')).toBe('video');
    expect(smartCategoryOf('image')).toBe('image');
    expect(smartCategoryOf('document')).toBe('document');
    expect(smartCategoryOf('audio')).toBe('audio');
    expect(smartCategoryOf('archive')).toBe('archive');
    expect(smartCategoryOf('installer')).toBe('installer');
    expect(smartCategoryOf('diskImage')).toBe('other');
    expect(smartCategoryOf('program')).toBe('other');
    expect(smartCategoryOf('other')).toBe('other');

    const base = { sourceDir: 'C:\\docs', targetRoot: 'D:\\归档', categories: ['video'] };
    expect(smartOrganizePreviewSchema.parse(base).categories).toEqual(['video']);
    expect(smartOrganizePreviewSchema.safeParse({ ...base, categories: [] }).success).toBe(false);
    expect(smartOrganizePreviewSchema.safeParse({ ...base, categories: ['bad'] }).success).toBe(
      false,
    );
    expect(
      smartOrganizePreviewSchema.safeParse({ sourceDir: 'C:\\docs', categories: ['video'] })
        .success,
    ).toBe(false);
  });
});
