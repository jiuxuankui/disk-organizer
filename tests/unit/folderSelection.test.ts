import { describe, expect, it } from 'vitest';
import type { FileRecord, FolderFacet } from '@shared/types';
import {
  emptyFolderSelection,
  folderSelectionTotals,
  toggleFolderFileSelection,
  toggleFolderSelection,
} from '../../src/renderer/lib/folderSelection';
import { isSameOrSubPath, isStrictSubPath } from '../../src/renderer/lib/filesFilter';

const folder = (path: string, bytes: number, count: number): FolderFacet => ({
  drive: 'C:',
  path,
  name: path.slice(path.lastIndexOf('\\') + 1),
  bytes,
  count,
});
const file = (id: number, path: string, size: number): FileRecord =>
  ({ id, path, name: path.slice(path.lastIndexOf('\\') + 1), size }) as FileRecord;

describe('folder selection', () => {
  it('matches folders and files by path boundaries', () => {
    expect(isSameOrSubPath('C:\\Tree\\a.bin', 'C:\\Tree')).toBe(true);
    expect(isSameOrSubPath('C:\\Tree\\Sub\\b.bin', 'c:\\tree\\')).toBe(true);
    expect(isSameOrSubPath('C:\\Treehouse\\x.bin', 'C:\\Tree')).toBe(false);
    expect(isStrictSubPath('C:\\Tree', 'C:\\Tree')).toBe(false);
    expect(isStrictSubPath('C:\\Tree\\Sub', 'C:\\Tree')).toBe(true);
    expect(isStrictSubPath('C:\\Other', 'C:\\Tree')).toBe(false);
    expect(isSameOrSubPath('C:\\a.bin', 'C:\\')).toBe(true);
  });

  it('merges an outer folder selection and drops inner folders and files', () => {
    let state = emptyFolderSelection();
    const tree = folder('C:\\Tree', 100, 2);
    const sub = folder('C:\\Tree\\Sub', 50, 1);
    const outer = folder('C:\\Keep', 10, 1);
    state = toggleFolderSelection(state, outer, true);
    state = toggleFolderSelection(state, sub, true);
    state = toggleFolderFileSelection(state, file(1, 'C:\\Tree\\a.bin', 40), true);
    state = toggleFolderFileSelection(state, file(2, 'C:\\Tree\\Sub\\b.bin', 60), true);
    state = toggleFolderFileSelection(state, file(3, 'C:\\Elsewhere\\c.bin', 5), true);
    expect(state.folders.size).toBe(2);
    expect(state.files.size).toBe(3);

    state = toggleFolderSelection(state, tree, true);
    expect([...state.folders.keys()]).toEqual(['C:\\Keep', 'C:\\Tree']);
    expect([...state.files.keys()]).toEqual([3]);
  });

  it('unchecks a folder without touching its files or siblings', () => {
    let state = emptyFolderSelection();
    const tree = folder('C:\\Tree', 100, 2);
    state = toggleFolderSelection(state, tree, true);
    state = toggleFolderFileSelection(state, file(1, 'C:\\Tree\\a.bin', 40), true);
    state = toggleFolderSelection(state, tree, false);
    expect(state.folders.size).toBe(0);
    expect(state.files.size).toBe(1);
  });

  it('sums recursive folder totals plus single files without double counting', () => {
    let state = emptyFolderSelection();
    state = toggleFolderSelection(state, folder('C:\\Tree', 300, 4), true);
    state = toggleFolderSelection(state, folder('C:\\Keep', 100, 1), true);
    state = toggleFolderFileSelection(state, file(1, 'C:\\Elsewhere\\a.bin', 50), true);
    state = toggleFolderFileSelection(state, file(2, 'C:\\Elsewhere\\b.bin', 25), true);
    expect(folderSelectionTotals(state)).toEqual({
      folderCount: 2,
      folderFileCount: 5,
      folderBytes: 400,
      fileCount: 2,
      fileBytes: 75,
      totalBytes: 475,
    });
  });
});
