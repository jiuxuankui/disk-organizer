import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { DuplicateGroupPage, DuplicatesState } from '@shared/types';
import type { IpcContext } from './context';
import {
  duplicateQuerySchema,
  duplicatesStartSchema,
  parseIpc,
  type DuplicateQueryPayload,
  type DuplicatesStartPayload,
} from './schemas';

export function registerDuplicatesIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.duplicatesDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要查找重复文件的文件夹',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.duplicatesState, (): DuplicatesState => ctx.duplicates.getState());

  ipcMain.handle(IPC.duplicatesStart, (_event, raw: unknown): DuplicatesState => {
    if (ctx.organize.isRunning()) throw new Error('文件整理进行中，请完成或停止后再查找重复文件');
    if (ctx.archive.isRunning()) throw new Error('压缩打包进行中，请完成或取消后再查找重复文件');
    if (ctx.video.isRunning()) throw new Error('视频压缩进行中，完成或取消后再查找重复文件');
    if (ctx.scan.isScanning()) throw new Error('扫描正在进行，完成或取消后才能查找重复文件');
    if (ctx.deleteService.isRunning()) throw new Error('删除进行中，完成或停止后再查找重复文件');
    const payload: DuplicatesStartPayload = parseIpc(
      duplicatesStartSchema,
      raw ?? {},
      '重复文件查找',
    );
    return ctx.duplicates.start(payload);
  });

  ipcMain.handle(IPC.duplicatesCancel, (): DuplicatesState => ctx.duplicates.cancel());

  ipcMain.handle(IPC.duplicatesGroups, (_event, raw: unknown): DuplicateGroupPage => {
    const query: DuplicateQueryPayload = parseIpc(duplicateQuerySchema, raw, '重复文件查询');
    return ctx.duplicates.query(query);
  });
}
