import { describe, expect, it } from 'vitest';
import type { DuplicateGroup } from '@shared/types';
import {
  buildDuplicateQuery,
  collectMemberSizes,
  describeGroupMeta,
  DUPLICATE_MIN_SIZE_OPTIONS,
  DUPLICATE_PAGE_SIZE,
  duplicateSortValue,
  groupAllSelected,
  groupByteTotal,
  groupSelectedCount,
  parseDuplicateSort,
  selectedGroupCount,
  selectedMemberIds,
  selectionSummary,
  suggestedMemberIds,
  toggleGroupSelection,
  type DuplicateFilters,
} from '../../src/renderer/lib/duplicates';

function member(fileId: number, size: number, suggestedKeep = false) {
  return {
    fileId,
    path: `C:\\data\\file-${fileId}.bin`,
    name: `file-${fileId}.bin`,
    size,
    mtimeMs: fileId * 1000,
    drive: 'C:',
    ext: 'bin',
    type: 'other' as const,
    suggestedKeep,
  };
}

function group(
  id: number,
  size: number,
  members: ReturnType<typeof member>[],
): DuplicateGroup {
  return {
    id,
    size,
    fileCount: members.length,
    reclaimableBytes: size * (members.length - 1),
    type: 'other',
    mixedExt: false,
    extensions: ['bin'],
    drives: ['C:'],
    members,
  };
}

const filters: DuplicateFilters = {
  minSize: 10 * 1024 * 1024,
  drive: 'D:',
  type: 'video',
  sortBy: 'count',
  sortOrder: 'asc',
};

describe('duplicate page helpers', () => {
  it('builds validated queries with the fixed page size', () => {
    const query = buildDuplicateQuery(filters, 3);
    expect(query).toEqual({
      minSize: 10 * 1024 * 1024,
      drive: 'D:',
      type: 'video',
      sortBy: 'count',
      sortOrder: 'asc',
      page: 3,
      pageSize: DUPLICATE_PAGE_SIZE,
    });
    expect(DUPLICATE_MIN_SIZE_OPTIONS.map((item) => item.value)).toEqual([
      1024 * 1024,
      10 * 1024 * 1024,
      100 * 1024 * 1024,
      0,
    ]);
  });

  it('parses and defaults sort selections', () => {
    expect(duplicateSortValue(filters)).toBe('count:asc');
    expect(parseDuplicateSort('size:desc')).toEqual({ sortBy: 'size', sortOrder: 'desc' });
    expect(parseDuplicateSort('bogus:up')).toEqual({
      sortBy: 'reclaimable',
      sortOrder: 'desc',
    });
  });

  it('selects every non-suggested copy and computes byte totals', () => {
    const first = group(1, 100, [
      member(1, 100, true),
      member(2, 100),
      member(3, 100),
    ]);
    const second = group(2, 50, [member(4, 50, true), member(5, 50)]);
    expect(suggestedMemberIds([first, second])).toEqual([2, 3, 5]);

    const selected = new Set([2, 3, 5]);
    expect(selectionSummary(selected, new Map([[2, 100], [3, 100], [5, 50]]))).toEqual(
      { count: 3, bytes: 250 },
    );
    expect(groupSelectedCount(first, selected)).toBe(2);
    expect(groupAllSelected(first, selected)).toBe(false);
    expect(groupByteTotal(first, selected)).toBe(200);
    expect(selectedGroupCount([first, second], selected)).toBe(0);
  });

  it('toggles whole groups and detects whole-group deletion', () => {
    const first = group(1, 100, [member(1, 100, true), member(2, 100)]);
    const second = group(2, 50, [member(3, 50)]);
    const all = toggleGroupSelection(first, new Set(), true);
    expect([...all].sort()).toEqual([1, 2]);
    expect(groupAllSelected(first, all)).toBe(true);
    expect(selectedGroupCount([first, second], all)).toBe(1);

    const removed = toggleGroupSelection(first, all, false);
    expect(removed.size).toBe(0);
    expect(groupAllSelected(first, removed)).toBe(false);
  });

  it('collects member sizes and lists selected ids', () => {
    const first = group(1, 100, [member(1, 100, true), member(2, 100)]);
    const sizes = collectMemberSizes([first], new Map());
    expect([...sizes.entries()]).toEqual([
      [1, 100],
      [2, 100],
    ]);
    expect(selectedMemberIds([first], new Set([2]))).toEqual([2]);
    expect(describeGroupMeta(first)).toContain('2 个文件');
  });
});
