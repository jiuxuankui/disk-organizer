import type { DuplicateGroup, DuplicateMember, DuplicateQuery } from '@shared/types';
import { formatBytes, formatCount } from '@shared/format';

export interface DuplicateFilters {
  minSize: number;
  drive: string | null;
  type: DuplicateQuery['type'];
  sortBy: DuplicateQuery['sortBy'];
  sortOrder: DuplicateQuery['sortOrder'];
}

export const DUPLICATE_PAGE_SIZE = 20;

export const DUPLICATE_MIN_SIZE_OPTIONS = [
  { value: 1024 * 1024, label: '1 MB' },
  { value: 10 * 1024 * 1024, label: '10 MB' },
  { value: 100 * 1024 * 1024, label: '100 MB' },
  { value: 0, label: '不限' },
] as const;

export const DUPLICATE_SORT_OPTIONS = [
  { value: 'reclaimable:desc', label: '可释放空间从大到小' },
  { value: 'reclaimable:asc', label: '可释放空间从小到大' },
  { value: 'size:desc', label: '文件大小从大到小' },
  { value: 'count:desc', label: '文件数量从多到少' },
] as const;

export function duplicateSortValue(filters: DuplicateFilters): string {
  return `${filters.sortBy}:${filters.sortOrder}`;
}

export function parseDuplicateSort(
  value: string,
): Pick<DuplicateFilters, 'sortBy' | 'sortOrder'> {
  const [sortBy, sortOrder] = value.split(':');
  const validSort =
    sortBy === 'reclaimable' || sortBy === 'size' || sortBy === 'count'
      ? sortBy
      : 'reclaimable';
  return {
    sortBy: validSort,
    sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
  };
}

export function buildDuplicateQuery(
  filters: DuplicateFilters,
  page: number,
): DuplicateQuery {
  return {
    minSize: filters.minSize,
    drive: filters.drive,
    type: filters.type ?? null,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    page,
    pageSize: DUPLICATE_PAGE_SIZE,
  };
}

export function memberKey(member: DuplicateMember): number {
  return member.fileId;
}

export function suggestedMemberIds(groups: DuplicateGroup[]): number[] {
  const ids: number[] = [];
  for (const group of groups) {
    for (const member of group.members) {
      if (!member.suggestedKeep) ids.push(member.fileId);
    }
  }
  return ids;
}

export function groupSelectedCount(group: DuplicateGroup, selected: Set<number>): number {
  let count = 0;
  for (const member of group.members) {
    if (selected.has(member.fileId)) count += 1;
  }
  return count;
}

export function groupAllSelected(group: DuplicateGroup, selected: Set<number>): boolean {
  return group.members.length > 0 && groupSelectedCount(group, selected) === group.members.length;
}

export function groupByteTotal(group: DuplicateGroup, selected: Set<number>): number {
  return group.size * groupSelectedCount(group, selected);
}

export function selectionSummary(
  selected: Set<number>,
  sizes: Map<number, number>,
): { count: number; bytes: number } {
  let bytes = 0;
  for (const id of selected) {
    bytes += sizes.get(id) ?? 0;
  }
  return { count: selected.size, bytes };
}

export function toggleGroupSelection(
  group: DuplicateGroup,
  selected: Set<number>,
  checked: boolean,
): Set<number> {
  const next = new Set(selected);
  for (const member of group.members) {
    if (checked) next.add(member.fileId);
    else next.delete(member.fileId);
  }
  return next;
}

export function selectedGroupCount(
  groups: DuplicateGroup[],
  selected: Set<number>,
): number {
  return groups.filter((group) => groupAllSelected(group, selected)).length;
}

export function selectedMemberIds(groups: DuplicateGroup[], selected: Set<number>): number[] {
  const ids: number[] = [];
  for (const group of groups) {
    for (const member of group.members) {
      if (selected.has(member.fileId)) ids.push(member.fileId);
    }
  }
  return ids;
}

export function collectMemberSizes(
  groups: DuplicateGroup[],
  target: Map<number, number>,
): Map<number, number> {
  const next = target.size === 0 ? new Map<number, number>() : new Map(target);
  for (const group of groups) {
    for (const member of group.members) next.set(member.fileId, member.size);
  }
  return next;
}

export function describeGroupMeta(group: DuplicateGroup): string {
  return `${formatCount(group.fileCount)} 个文件 · 可释放 ${formatBytes(group.reclaimableBytes)}`;
}
