import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import { organizePreviewSchema, organizeStartSchema } from '@shared/organize';
import { parseIpc } from './schemas';
import type { IpcContext } from './context';

function ensureIdle(ctx: IpcContext): void {
  if (
    ctx.scan.isBusy() ||
    ctx.duplicates.isRunning() ||
    ctx.deleteService.isRunning() ||
    ctx.video.isRunning() ||
    ctx.archive.isRunning()
  ) {
    throw new Error('请等待扫描、查重、删除或压缩任务完成后再整理');
  }
}
export function registerOrganizeIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.organizeDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择整理文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.organizePreview, (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.plan(parseIpc(organizePreviewSchema, raw, '整理预览'));
  });
  ipcMain.handle(IPC.organizeStart, (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.start(parseIpc(organizeStartSchema, raw, '移动文件'));
  });
  ipcMain.handle(IPC.organizeState, () => ctx.organize.getState());
  ipcMain.handle(IPC.organizeCancel, () => ctx.organize.cancel());
}
