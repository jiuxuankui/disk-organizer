import type { FileRecord } from '@shared/types';

export type SelectionMode = 'subset' | 'all';

export interface FilesSelection {
  mode: SelectionMode;
  keys: number[];
}

export const EMPTY_SELECTION: FilesSelection = { mode: 'subset', keys: [] };

export function selectAllLoaded(loadedIds: number[]): FilesSelection {
  return { mode: 'subset', keys: [...loadedIds] };
}

export function selectAllFiltered(loadedIds: number[]): FilesSelection {
  return { mode: 'all', keys: [...loadedIds] };
}

export function toggleRow(
  selection: FilesSelection,
  id: number,
  checked: boolean,
): FilesSelection {
  const keys = new Set(selection.keys);
  if (checked) keys.add(id);
  else keys.delete(id);
  return { mode: 'subset', keys: [...keys] };
}

export function clearSelection(): FilesSelection {
  return { mode: 'subset', keys: [] };
}

export function appendLoadedKeys(
  selection: FilesSelection,
  loadedIds: number[],
): FilesSelection {
  if (selection.mode !== 'all') return selection;
  const keys = new Set(selection.keys);
  let changed = false;
  for (const id of loadedIds) {
    if (!keys.has(id)) {
      keys.add(id);
      changed = true;
    }
  }
  return changed ? { mode: 'all', keys: [...keys] } : selection;
}

export function selectedCount(selection: FilesSelection, total: number): number {
  return selection.mode === 'all' ? total : selection.keys.length;
}

export function selectedBytes(
  selection: FilesSelection,
  loaded: FileRecord[],
  totalBytes: number,
): number {
  if (selection.mode === 'all') return totalBytes;
  if (selection.keys.length === 0) return 0;
  const wanted = new Set(selection.keys);
  let bytes = 0;
  for (const file of loaded) {
    if (wanted.has(file.id)) bytes += file.size;
  }
  return bytes;
}

export function canSelectAllFiltered(selection: FilesSelection, total: number): boolean {
  if (selection.mode === 'all') return false;
  return selection.keys.length > 0 && total > selection.keys.length;
}

export function headerChecked(
  selection: FilesSelection,
  loadedIds: number[],
  total: number,
): boolean {
  if (selection.mode === 'all') return total > 0;
  if (loadedIds.length === 0) return false;
  const keys = new Set(selection.keys);
  return loadedIds.every((id) => keys.has(id));
}

export function headerIndeterminate(
  selection: FilesSelection,
  loadedIds: number[],
  total: number,
): boolean {
  if (selection.mode === 'all') return false;
  if (selection.keys.length === 0) return false;
  return !headerChecked(selection, loadedIds, total);
}
