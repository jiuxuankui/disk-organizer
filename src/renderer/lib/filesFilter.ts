import type { FileQuery, FileTypeKey } from '@shared/types';
import { formatBytes } from '@shared/format';
import { fileTypeLabel } from '@shared/fileTypes';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

export type FolderScope = 'root' | 'dir' | 'subtree';
export type FilesView = 'files' | 'folders';

export interface FolderFilter {
  path: string;
  scope: FolderScope;
}

export interface FilesFilters {
  view: FilesView;
  drive: string | null;
  type: FileTypeKey | null;
  minSize: number | null;
  maxSize: number | null;
  mtimeFrom: number | null;
  mtimeTo: number | null;
  timePreset: string;
  folder: FolderFilter | null;
}

export interface FileSort {
  sortBy: FileQuery['sortBy'];
  sortOrder: FileQuery['sortOrder'];
}

export const DEFAULT_FILES_FILTERS: FilesFilters = {
  view: 'files',
  drive: null,
  type: null,
  minSize: null,
  maxSize: null,
  mtimeFrom: null,
  mtimeTo: null,
  timePreset: 'all',
  folder: null,
};

export const DEFAULT_FILE_SORT: FileSort = { sortBy: 'size', sortOrder: 'desc' };

export interface SizePreset {
  key: string;
  label: string;
  minSize: number | null;
  maxSize: number | null;
}

export const SIZE_PRESETS: readonly SizePreset[] = [
  { key: 'all', label: '全部大小', minSize: null, maxSize: null },
  { key: 'tiny', label: '小于 1 MB', minSize: null, maxSize: MB - 1 },
  { key: 'small', label: '1 MB – 100 MB', minSize: MB, maxSize: 100 * MB - 1 },
  { key: 'medium', label: '100 MB – 1 GB', minSize: 100 * MB, maxSize: GB - 1 },
  { key: 'large', label: '1 GB – 10 GB', minSize: GB, maxSize: 10 * GB - 1 },
  { key: 'huge', label: '大于 10 GB', minSize: 10 * GB, maxSize: null },
];

export interface TimePreset {
  key: string;
  label: string;
}

export const TIME_PRESETS: readonly TimePreset[] = [
  { key: 'all', label: '全部时间' },
  { key: '7d', label: '最近 7 天' },
  { key: '30d', label: '最近 30 天' },
  { key: '1y', label: '最近一年' },
  { key: 'older', label: '一年前更早' },
];

export function applyTimePreset(
  key: string,
  now = Date.now(),
): { mtimeFrom: number | null; mtimeTo: number | null } {
  switch (key) {
    case '7d':
      return { mtimeFrom: now - 7 * DAY, mtimeTo: null };
    case '30d':
      return { mtimeFrom: now - 30 * DAY, mtimeTo: null };
    case '1y':
      return { mtimeFrom: now - 365 * DAY, mtimeTo: null };
    case 'older':
      return { mtimeFrom: null, mtimeTo: now - 365 * DAY };
    default:
      return { mtimeFrom: null, mtimeTo: null };
  }
}

export function applySizePreset(preset: SizePreset): {
  minSize: number | null;
  maxSize: number | null;
} {
  return { minSize: preset.minSize, maxSize: preset.maxSize };
}

export function sizePresetKey(minSize: number | null, maxSize: number | null): string {
  const match = SIZE_PRESETS.find(
    (preset) => preset.minSize === minSize && preset.maxSize === maxSize,
  );
  return match?.key ?? 'custom';
}

export function firstLevelFolder(path: string): string | null {
  const match = /^[A-Za-z]:\\([^\\/]+)[\\/]?$/.exec(path.trim().replace(/\//g, '\\'));
  return match ? match[1] : null;
}

export function folderFromRootPath(drive: string | null, path: string): FolderFilter | null {
  if (!drive) return null;
  const trimmed = path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const prefix = `${drive.charAt(0).toUpperCase()}:\\`;
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = trimmed.slice(prefix.length);
  if (!rest || rest.includes('\\')) return null;
  return { path: `${prefix}${rest}`, scope: 'root' };
}

export function folderFromDirectory(path: string): FolderFilter | null {
  const trimmed = path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  return trimmed ? { path: trimmed, scope: 'dir' } : null;
}

export function folderFromSubtree(path: string): FolderFilter | null {
  const trimmed = path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  return trimmed ? { path: trimmed, scope: 'subtree' } : null;
}

function pathKey(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function isSameOrSubPath(child: string, parent: string): boolean {
  const childKey = pathKey(child);
  const parentKey = pathKey(parent);
  if (childKey === parentKey) return true;
  return childKey.startsWith(`${parentKey}\\`);
}

export function isStrictSubPath(child: string, parent: string): boolean {
  const childKey = pathKey(child);
  const parentKey = pathKey(parent);
  return childKey !== parentKey && childKey.startsWith(`${parentKey}\\`);
}

export function typeFilterKey(filters: FilesFilters): string {
  if (filters.view === 'folders') return 'folder';
  return filters.type ?? 'all';
}

export function applyTypeFilterValue(value: string): Partial<FilesFilters> {
  if (value === 'folder') return { view: 'folders', type: null, folder: null };
  if (value === 'all') return { view: 'files', type: null, folder: null };
  return { view: 'files', type: value as FileTypeKey, folder: null };
}

export function filtersFromPrefill(prefill: {
  drive: string | null;
  type: FileTypeKey | null;
  rootPath: string | null;
}): FilesFilters {
  return {
    ...DEFAULT_FILES_FILTERS,
    drive: prefill.drive,
    type: prefill.type,
    folder: prefill.rootPath
      ? (folderFromRootPath(prefill.drive, prefill.rootPath) ??
        folderFromDirectory(prefill.rootPath))
      : null,
  };
}

export function withoutFilter(filters: FilesFilters, key: FilterTag['key']): FilesFilters {
  switch (key) {
    case 'drive':
      return { ...filters, drive: null };
    case 'type':
      return { ...filters, type: null };
    case 'size':
      return { ...filters, minSize: null, maxSize: null };
    case 'time':
      return { ...filters, mtimeFrom: null, mtimeTo: null, timePreset: 'all' };
    case 'folder':
      return { ...filters, folder: null };
    default:
      return filters;
  }
}

export function buildFileQuery(options: {
  filters: FilesFilters;
  sort: FileSort;
  search: string;
  page: number;
  pageSize: number;
}): FileQuery {
  const { filters, sort, search, page, pageSize } = options;
  const folder = filters.folder;
  const rootDir = folder?.scope === 'root' ? (firstLevelFolder(folder.path) ?? null) : null;
  return {
    drive: filters.drive,
    type: filters.type,
    minSize: filters.minSize,
    maxSize: filters.maxSize,
    mtimeFrom: filters.mtimeFrom,
    mtimeTo: filters.mtimeTo,
    rootDir,
    dirPath: folder?.scope === 'dir' ? folder.path : null,
    dirPrefix: folder?.scope === 'subtree' ? folder.path : null,
    search: search.trim() || undefined,
    sortBy: sort.sortBy,
    sortOrder: sort.sortOrder,
    page,
    pageSize,
  };
}

export function hasActiveFilters(filters: FilesFilters, search = ''): boolean {
  return (
    filters.drive !== null ||
    filters.type !== null ||
    filters.minSize !== null ||
    filters.maxSize !== null ||
    filters.mtimeFrom !== null ||
    filters.mtimeTo !== null ||
    filters.folder !== null ||
    search.trim().length > 0
  );
}

export interface FilterTag {
  key: 'drive' | 'type' | 'size' | 'time' | 'folder' | 'search';
  label: string;
}

export function describeSizeRange(minSize: number | null, maxSize: number | null): string {
  if (minSize === null && maxSize === null) return '';
  if (minSize === null) return `小于 ${formatBytes((maxSize ?? 0) + 1)}`;
  if (maxSize === null) return `大于 ${formatBytes(minSize)}`;
  return `${formatBytes(minSize)} – ${formatBytes(maxSize + 1)}`;
}

export function describeTimeRange(
  mtimeFrom: number | null,
  mtimeTo: number | null,
  now = Date.now(),
): string {
  if (mtimeFrom === null && mtimeTo === null) return '';
  if (mtimeFrom === null) return '一年前更早';
  const days = Math.max(1, Math.round((now - mtimeFrom) / DAY));
  if (mtimeTo === null && days === 7) return '最近 7 天';
  if (mtimeTo === null && days === 30) return '最近 30 天';
  if (mtimeTo === null && days === 365) return '最近一年';
  return `最近 ${days} 天`;
}

export function activeFilterTags(
  filters: FilesFilters,
  search = '',
  now = Date.now(),
): FilterTag[] {
  const tags: FilterTag[] = [];
  if (filters.drive) tags.push({ key: 'drive', label: `硬盘 ${filters.drive}` });
  if (filters.type) {
    tags.push({ key: 'type', label: `类型 ${fileTypeLabel(filters.type)}` });
  }
  const size = describeSizeRange(filters.minSize, filters.maxSize);
  if (size) tags.push({ key: 'size', label: size });
  const time = describeTimeRange(filters.mtimeFrom, filters.mtimeTo, now);
  if (time) tags.push({ key: 'time', label: time });
  if (filters.folder) tags.push({ key: 'folder', label: filters.folder.path });
  if (search.trim()) tags.push({ key: 'search', label: `搜索“${search.trim()}”` });
  return tags;
}
