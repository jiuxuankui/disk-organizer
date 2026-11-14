import { describe, expect, it } from 'vitest';
import {
  activeFilterTags,
  applySizePreset,
  applyTimePreset,
  applyTypeFilterValue,
  buildFileQuery,
  DEFAULT_FILE_SORT,
  DEFAULT_FILES_FILTERS,
  describeSizeRange,
  describeTimeRange,
  filtersFromPrefill,
  firstLevelFolder,
  folderFromDirectory,
  folderFromRootPath,
  folderFromSelectionKey,
  folderSelectionKey,
  hasActiveFilters,
  SIZE_PRESETS,
  sizePresetKey,
  typeFilterKey,
  withoutFilter,
  type FilesFilters,
} from '../../src/renderer/lib/filesFilter';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('files filter helpers', () => {
  it('builds a default query with size descending', () => {
    const query = buildFileQuery({
      filters: DEFAULT_FILES_FILTERS,
      sort: DEFAULT_FILE_SORT,
      search: '  ',
      page: 1,
      pageSize: 200,
    });
    expect(query).toEqual({
      drive: null,
      type: null,
      minSize: null,
      maxSize: null,
      mtimeFrom: null,
      mtimeTo: null,
      rootDir: null,
      dirPath: null,
      search: undefined,
      sortBy: 'size',
      sortOrder: 'desc',
      page: 1,
      pageSize: 200,
    });
  });

  it('maps every filter into the query', () => {
    const filters: FilesFilters = {
      drive: 'D:',
      type: 'video',
      minSize: 10,
      maxSize: 20,
      mtimeFrom: 100,
      mtimeTo: 200,
      timePreset: 'custom',
      folder: { path: 'D:\\Movies', scope: 'root' },
    };
    const query = buildFileQuery({
      filters,
      sort: { sortBy: 'name', sortOrder: 'asc' },
      search: '  holiday ',
      page: 3,
      pageSize: 500,
    });
    expect(query.drive).toBe('D:');
    expect(query.type).toBe('video');
    expect(query.minSize).toBe(10);
    expect(query.maxSize).toBe(20);
    expect(query.mtimeFrom).toBe(100);
    expect(query.mtimeTo).toBe(200);
    expect(query.rootDir).toBe('Movies');
    expect(query.dirPath).toBeNull();
    expect(query.search).toBe('holiday');
    expect(query.sortBy).toBe('name');
    expect(query.sortOrder).toBe('asc');
    expect(query.page).toBe(3);
    expect(query.pageSize).toBe(500);
  });

  it('distinguishes a first-level folder from an exact directory filter', () => {
    const root = buildFileQuery({
      filters: { ...DEFAULT_FILES_FILTERS, folder: { path: 'C:\\Movies', scope: 'root' } },
      sort: DEFAULT_FILE_SORT,
      search: '',
      page: 1,
      pageSize: 200,
    });
    expect(root.rootDir).toBe('Movies');
    expect(root.dirPath).toBeNull();

    const exact = buildFileQuery({
      filters: {
        ...DEFAULT_FILES_FILTERS,
        folder: { path: 'C:\\Movies\\Sub', scope: 'dir' },
      },
      sort: DEFAULT_FILE_SORT,
      search: '',
      page: 1,
      pageSize: 200,
    });
    expect(exact.rootDir).toBeNull();
    expect(exact.dirPath).toBe('C:\\Movies\\Sub');
  });

  it('parses drilldown prefill into filters', () => {
    expect(filtersFromPrefill({ drive: 'C:', type: 'image', rootPath: 'C:\\Pics' })).toMatchObject({
      drive: 'C:',
      type: 'image',
      folder: { path: 'C:\\Pics', scope: 'root' },
    });
    expect(
      filtersFromPrefill({ drive: null, type: null, rootPath: 'C:\\Pics\\2024' }).folder,
    ).toEqual({ path: 'C:\\Pics\\2024', scope: 'dir' });
    expect(filtersFromPrefill({ drive: null, type: null, rootPath: null }).folder).toBeNull();
    expect(folderFromRootPath('D:', 'C:\\Pics')).toBeNull();
    expect(folderFromDirectory(' C:/Pics/2024/ ')).toEqual({
      path: 'C:\\Pics\\2024',
      scope: 'dir',
    });
    expect(firstLevelFolder('C:\\Movies')).toBe('Movies');
    expect(firstLevelFolder('C:\\Movies\\Sub')).toBeNull();
    expect(firstLevelFolder('C:\\')).toBeNull();
  });

  it('maps folder facets to selectable filter values', () => {
    const folders = [
      { drive: 'C:', path: 'C:\\Movies', name: 'Movies', bytes: 1200, count: 3 },
      { drive: 'D:', path: 'D:\\Backup', name: 'Backup', bytes: 2000, count: 1 },
    ];
    expect(folderSelectionKey(null)).toBe('all');
    expect(folderSelectionKey({ path: 'C:\\Movies', scope: 'root' })).toBe('root:C:\\Movies');
    expect(folderFromSelectionKey(folders, 'root:C:\\Movies')).toEqual({
      path: 'C:\\Movies',
      scope: 'root',
    });
    expect(folderFromSelectionKey(folders, 'all')).toBeNull();
    expect(folderFromSelectionKey(folders, 'root:C:\\Missing')).toBeNull();
  });

  it('merges the folder filter into the type dropdown value', () => {
    const folders = [
      { drive: 'C:', path: 'C:\\Movies', name: 'Movies', bytes: 1200, count: 3 },
      { drive: 'D:', path: 'D:\\Backup', name: 'Backup', bytes: 2000, count: 1 },
    ];
    expect(typeFilterKey(DEFAULT_FILES_FILTERS)).toBe('all');
    expect(typeFilterKey({ ...DEFAULT_FILES_FILTERS, type: 'video' })).toBe('video');
    expect(
      typeFilterKey({ ...DEFAULT_FILES_FILTERS, folder: { path: 'C:\\Movies', scope: 'root' } }),
    ).toBe('root:C:\\Movies');

    expect(applyTypeFilterValue('all', folders)).toEqual({ type: null, folder: null });
    expect(applyTypeFilterValue('video', folders)).toEqual({ type: 'video', folder: null });
    expect(applyTypeFilterValue('root:C:\\Movies', folders)).toEqual({
      folder: { path: 'C:\\Movies', scope: 'root' },
      type: null,
      drive: 'C:',
    });
    expect(applyTypeFilterValue('root:C:\\Missing', folders)).toEqual({
      folder: null,
      type: null,
    });
  });

  it('applies size and time presets', () => {
    const sevenDays = applyTimePreset('7d', NOW);
    expect(sevenDays).toEqual({ mtimeFrom: NOW - 7 * DAY, mtimeTo: null });
    expect(applyTimePreset('30d', NOW).mtimeFrom).toBe(NOW - 30 * DAY);
    expect(applyTimePreset('1y', NOW).mtimeFrom).toBe(NOW - 365 * DAY);
    expect(applyTimePreset('older', NOW)).toEqual({ mtimeFrom: null, mtimeTo: NOW - 365 * DAY });
    expect(applyTimePreset('all', NOW)).toEqual({ mtimeFrom: null, mtimeTo: null });

    const medium = SIZE_PRESETS.find((preset) => preset.key === 'medium');
    expect(medium).toBeDefined();
    expect(applySizePreset(medium!)).toEqual({ minSize: 100 * MB, maxSize: GB - 1 });
    expect(sizePresetKey(100 * MB, GB - 1)).toBe('medium');
    expect(sizePresetKey(null, null)).toBe('all');
    expect(sizePresetKey(123, 456)).toBe('custom');
  });

  it('describes ranges and builds removable tags', () => {
    expect(describeSizeRange(null, null)).toBe('');
    expect(describeSizeRange(MB, 100 * MB - 1)).toContain('–');
    expect(describeSizeRange(10 * GB, null)).toContain('大于');
    expect(describeTimeRange(NOW - 7 * DAY, null, NOW)).toBe('最近 7 天');
    expect(describeTimeRange(null, NOW - 365 * DAY, NOW)).toBe('一年前更早');
    expect(describeTimeRange(null, null, NOW)).toBe('');

    const filters: FilesFilters = {
      drive: 'C:',
      type: 'video',
      minSize: MB,
      maxSize: 100 * MB - 1,
      mtimeFrom: NOW - 7 * DAY,
      mtimeTo: null,
      timePreset: '7d',
      folder: { path: 'C:\\Movies', scope: 'root' },
    };
    const tags = activeFilterTags(filters, 'movie', NOW);
    expect(tags.map((tag) => tag.key)).toEqual([
      'drive',
      'type',
      'size',
      'time',
      'folder',
      'search',
    ]);
    expect(tags.find((tag) => tag.key === 'type')?.label).toContain('视频');
    expect(tags.find((tag) => tag.key === 'search')?.label).toContain('movie');
    expect(hasActiveFilters(filters, 'movie')).toBe(true);
    expect(hasActiveFilters(DEFAULT_FILES_FILTERS, '')).toBe(false);
  });

  it('removes filters independently and clears time presets', () => {
    const filters: FilesFilters = {
      drive: 'C:',
      type: 'video',
      minSize: MB,
      maxSize: 2 * MB,
      mtimeFrom: 1,
      mtimeTo: 2,
      timePreset: '7d',
      folder: { path: 'C:\\Movies', scope: 'root' },
    };
    expect(withoutFilter(filters, 'drive').drive).toBeNull();
    expect(withoutFilter(filters, 'type').type).toBeNull();
    expect(withoutFilter(filters, 'size')).toMatchObject({ minSize: null, maxSize: null });
    expect(withoutFilter(filters, 'time')).toMatchObject({
      mtimeFrom: null,
      mtimeTo: null,
      timePreset: 'all',
    });
    expect(withoutFilter(filters, 'folder').folder).toBeNull();
    expect(withoutFilter(filters, 'search')).toBe(filters);
  });
});
