import { describe, expect, it } from 'vitest';
import type { FileRecord } from '@shared/types';
import {
  appendLoadedKeys,
  canSelectAllFiltered,
  clearSelection,
  EMPTY_SELECTION,
  headerChecked,
  headerIndeterminate,
  selectAllFiltered,
  selectAllLoaded,
  selectedBytes,
  selectedCount,
  toggleRow,
} from '../../src/renderer/lib/filesSelection';

function record(id: number, size: number): FileRecord {
  return {
    id,
    drive: 'C:',
    path: `C:\\files\\${id}.bin`,
    name: `${id}.bin`,
    ext: 'bin',
    type: 'other',
    size,
    mtimeMs: 0,
    ctimeMs: 0,
    rootDir: 'files',
    dirPath: 'C:\\files',
  };
}

const loaded = [record(1, 100), record(2, 200), record(3, 300)];

describe('files selection helpers', () => {
  it('counts and sums only selected loaded rows', () => {
    const subset = selectAllLoaded([1, 3]);
    expect(selectedCount(subset, 100)).toBe(2);
    expect(selectedBytes(subset, loaded, 6000)).toBe(400);
    expect(selectedBytes(selectAllLoaded([99]), loaded, 6000)).toBe(0);
    expect(EMPTY_SELECTION.keys).toEqual([]);
    expect(clearSelection()).toEqual({ mode: 'subset', keys: [] });
  });

  it('treats all-filtered selection as the full result set', () => {
    const all = selectAllFiltered([1, 2]);
    expect(all.mode).toBe('all');
    expect(selectedCount(all, 12345)).toBe(12345);
    expect(selectedBytes(all, loaded, 9000)).toBe(9000);
    expect(canSelectAllFiltered(all, 12345)).toBe(false);
  });

  it('returns to subset mode when a row is toggled', () => {
    const all = selectAllFiltered([1, 2, 3]);
    expect(toggleRow(all, 2, false)).toEqual({ mode: 'subset', keys: [1, 3] });
    expect(toggleRow(all, 9, true)).toEqual({ mode: 'subset', keys: [1, 2, 3, 9] });
    expect(toggleRow(selectAllLoaded([1]), 1, true).keys).toEqual([1]);
  });

  it('offers select-all-filtered only when the subset is smaller than the total', () => {
    expect(canSelectAllFiltered(selectAllLoaded([1]), 3)).toBe(true);
    expect(canSelectAllFiltered(selectAllLoaded([1, 2, 3]), 3)).toBe(false);
    expect(canSelectAllFiltered(EMPTY_SELECTION, 3)).toBe(false);
  });

  it('appends newly loaded rows only while all-filtered', () => {
    const all = selectAllFiltered([1]);
    expect(appendLoadedKeys(all, [2, 3]).keys).toEqual([1, 2, 3]);
    expect(appendLoadedKeys(all, [1]).keys).toEqual([1]);
    const subset = selectAllLoaded([1]);
    expect(appendLoadedKeys(subset, [2])).toBe(subset);
  });

  it('reports header checkbox state for loaded rows', () => {
    expect(headerChecked(selectAllLoaded([1, 2, 3]), [1, 2, 3], 3)).toBe(true);
    expect(headerChecked(selectAllLoaded([1]), [1, 2, 3], 3)).toBe(false);
    expect(headerIndeterminate(selectAllLoaded([1]), [1, 2, 3], 3)).toBe(true);
    expect(headerIndeterminate(EMPTY_SELECTION, [1, 2, 3], 3)).toBe(false);
    expect(headerChecked(selectAllFiltered([1, 2, 3]), [1, 2, 3], 5)).toBe(true);
  });
});
