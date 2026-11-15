import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { DeletePreview, DeleteProgress, RecycleStatus } from '@shared/types';
import type { IpcContext } from './context';
import { deleteFilesSchema, parseIpc, type DeleteFilesPayload } from './schemas';

function ensureIdle(ctx: IpcContext): void {
  if (ctx.organize.isRunning()) throw new Error('文件整理进行中，请完成或停止后再删除文件');
  if (ctx.rename.isRunning()) throw new Error('批量重命名进行中，请完成或停止后再删除文件');
  if (ctx.archive.isRunning()) throw new Error('压缩打包进行中，请完成或取消后再删除文件');
  if (ctx.video.isRunning()) throw new Error('视频压缩进行中，完成或取消后再删除文件');
  if (ctx.scan.isBusy()) throw new Error('扫描进行中，完成后再删除文件');
  if (ctx.duplicates.isRunning()) throw new Error('重复文件查找进行中，完成或取消后再删除文件');
  if (ctx.deleteService.isRunning()) throw new Error('删除正在进行，请等待完成或先停止');
}

export function registerDeleteIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.deleteStatus, (): RecycleStatus => ctx.deleteService.status());

  ipcMain.handle(IPC.deletePreview, (_event, raw: unknown): DeletePreview => {
    const payload: DeleteFilesPayload = parseIpc(deleteFilesSchema, raw, '删除预览');
    if (ctx.scan.isBusy()) throw new Error('扫描进行中，完成后再删除文件');
    if (ctx.rename.isRunning()) throw new Error('批量重命名进行中，请完成或停止后再删除文件');
    return ctx.deleteService.preview(payload.fileIds, payload.folderPaths);
  });

  ipcMain.handle(IPC.deleteExecute, (_event, raw: unknown): DeleteProgress => {
    const payload: DeleteFilesPayload = parseIpc(deleteFilesSchema, raw, '删除文件');
    ensureIdle(ctx);
    return ctx.deleteService.start(payload.fileIds, payload.folderPaths);
  });

  ipcMain.handle(IPC.deleteCancel, (): DeleteProgress => ctx.deleteService.cancel());
}
