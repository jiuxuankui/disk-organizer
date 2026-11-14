import { describe, expect, it } from 'vitest';
import type { FileRecord } from '@shared/types';
import {
  organizePreviewSchema,
  organizeRuleSchema,
  organizeRulesSchema,
  organizeStartSchema,
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
    expect(parsed.matchMode).toBe('all');

    expect(organizeRuleSchema.safeParse({ ...rule, minSize: 20, maxSize: 10 }).success).toBe(false);
    expect(organizeRuleSchema.safeParse({ ...rule, mtimeFrom: 200, mtimeTo: 100 }).success).toBe(
      false,
    );
    expect(organizeRuleSchema.safeParse({ ...rule, matchMode: 'neither' }).success).toBe(false);
  });
});
