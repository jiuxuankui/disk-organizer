import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { FileQuery, FileRecord, PagedResult } from '@shared/types';
import { getFileById, queryFileIds, queryFiles } from '../db/filesRepo';
import { getActiveScanId } from '../db/scansRepo';
import type { IpcContext } from './context';
import { fileIdSchema, fileQuerySchema, parseIpc } from './schemas';

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
}
