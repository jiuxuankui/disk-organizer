import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type {
  FileQuery,
  FileRecord,
  FolderContents,
  FolderFacet,
  IndexSyncResult,
  PagedResult,
} from '@shared/types';
import {
  getFileById,
  getFilesByIds,
  listFolderContents,
  listFolders,
  queryFileIds,
  queryFiles,
} from '../db/filesRepo';
import { getActiveScanId } from '../db/scansRepo';
import type { IpcContext } from './context';
import { fileIdSchema, fileIdsSchema, fileQuerySchema, folderQuerySchema, parseIpc } from './schemas';

function emptyPage(query?: Partial<FileQuery>): PagedResult<FileRecord> {
  return {
    items: [],
    total: 0,
    totalBytes: 0,
    page: query?.page ?? 1,
    pageSize: query?.pageSize ?? 200,
  };
}

export function registerFilesIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.filesQuery, (_event, raw: unknown): PagedResult<FileRecord> => {
    const query = parseIpc(fileQuerySchema, raw, '文件查询');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return emptyPage(query);
    return queryFiles(ctx.db, scanId, query);
  });

  ipcMain.handle(IPC.filesListIds, (_event, raw: unknown): number[] => {
    const query = parseIpc(fileQuerySchema, raw, '文件查询');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return [];
    return queryFileIds(ctx.db, scanId, query);
  });

  ipcMain.handle(IPC.filesGet, (_event, raw: unknown): FileRecord | null => {
    const { id } = parseIpc(fileIdSchema, raw, '文件详情');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return null;
    return getFileById(ctx.db, scanId, id);
  });

  ipcMain.handle(IPC.filesGetMany, (_event, raw: unknown): FileRecord[] => {
    const { fileIds } = parseIpc(fileIdsSchema, raw, '批量读取文件');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return [];
    const unique = [...new Set(fileIds)];
    const result: FileRecord[] = [];
    for (let index = 0; index < unique.length; index += 500) {
      result.push(...getFilesByIds(ctx.db, scanId, unique.slice(index, index + 500)));
    }
    return result;
  });

  ipcMain.handle(IPC.filesFacets, (_event, raw: unknown): FolderFacet[] => {
    const query = parseIpc(folderQuerySchema, raw, '文件夹查询');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return [];
    return listFolders(ctx.db, scanId, query);
  });

  ipcMain.handle(IPC.filesFolderContents, (_event, raw: unknown): FolderContents => {
    const query = parseIpc(folderQuerySchema, raw, '文件夹内容');
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) return { folders: [], files: [], totalFiles: 0 };
    return listFolderContents(ctx.db, scanId, query);
  });

  ipcMain.handle(IPC.filesSyncIndex, (): Promise<IndexSyncResult> => ctx.indexSync.sync());
}
