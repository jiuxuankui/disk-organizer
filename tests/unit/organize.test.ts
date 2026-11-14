import { describe, expect, it } from 'vitest';
import type { FileRecord } from '@shared/types';
import {
  organizePreviewSchema,
  organizeRulesSchema,
  organizeStartSchema,
  type OrganizeRule,
} from '@shared/organize';
import { chooseOrganizeRule } from '../../src/main/services/organizeCore';

const rule: OrganizeRule = {
  id: 'dbb71d18-ab33-4a49-97ae-fcd4b035720b',
  name: '报告',
  enabled: true,
  type: 'document',
  extensions: ['pdf'],
  nameContains: 'report',
  targetDir: 'D:\\文档',
};
const file = { drive: 'C:', name: 'REPORT.PDF', ext: 'pdf', type: 'document' } as FileRecord;

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
});
