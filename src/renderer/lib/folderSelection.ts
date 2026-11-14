import type { FileRecord, FolderFacet } from '@shared/types';
import { isSameOrSubPath, isStrictSubPath } from './filesFilter';

export interface FolderSelectionState {
  folders: Map<string, FolderFacet>;
  files: Map<number, FileRecord>;
}

export function emptyFolderSelection(): FolderSelectionState {
  return { folders: new Map(), files: new Map() };
}

export function toggleFolderSelection(
  state: FolderSelectionState,
  folder: FolderFacet,
  checked: boolean,
): FolderSelectionState {
  const folders = new Map(state.folders);
  const files = new Map(state.files);
  if (checked) {
    for (const path of folders.keys()) {
      if (isStrictSubPath(path, folder.path)) folders.delete(path);
    }
    folders.set(folder.path, folder);
    for (const [id, file] of files) {
      if (isSameOrSubPath(file.path, folder.path)) files.delete(id);
    }
  } else {
    folders.delete(folder.path);
  }
  return { folders, files };
}

export function toggleFolderFileSelection(
  state: FolderSelectionState,
  file: FileRecord,
  checked: boolean,
): FolderSelectionState {
  const files = new Map(state.files);
  if (checked) files.set(file.id, file);
  else files.delete(file.id);
  return { folders: state.folders, files };
}

export function folderSelectionTotals(state: FolderSelectionState): {
  folderCount: number;
  folderFileCount: number;
  folderBytes: number;
  fileCount: number;
  fileBytes: number;
  totalBytes: number;
} {
  let folderFileCount = 0;
  let folderBytes = 0;
  for (const folder of state.folders.values()) {
    folderFileCount += folder.count;
    folderBytes += folder.bytes;
  }
  let fileBytes = 0;
  for (const file of state.files.values()) fileBytes += file.size;
  return {
    folderCount: state.folders.size,
    folderFileCount,
    folderBytes,
    fileCount: state.files.size,
    fileBytes,
    totalBytes: folderBytes + fileBytes,
  };
}
