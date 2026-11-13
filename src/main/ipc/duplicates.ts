import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { DuplicateGroupPage, DuplicatesState } from '@shared/types';
import type { IpcContext } from './context';
import { duplicateQuerySchema, parseIpc, type DuplicateQueryPayload } from './schemas';

export function registerDuplicatesIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.duplicatesState, (): DuplicatesState => ctx.duplicates.getState());

  ipcMain.handle(IPC.duplicatesStart, (): DuplicatesState => {
    if (ctx.scan.isScanning()) throw new Error('扫描正在进行，完成或取消后才能查找重复文件');
    return ctx.duplicates.start();
  });

  ipcMain.handle(IPC.duplicatesCancel, (): DuplicatesState => ctx.duplicates.cancel());

  ipcMain.handle(IPC.duplicatesGroups, (_event, raw: unknown): DuplicateGroupPage => {
    const query: DuplicateQueryPayload = parseIpc(duplicateQuerySchema, raw, '重复文件查询');
    return ctx.duplicates.query(query);
  });
}
