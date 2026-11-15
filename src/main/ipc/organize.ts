import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import {
  movePreviewSchema,
  moveStartSchema,
  organizePreviewSchema,
  organizeStartSchema,
  smartOrganizePreviewSchema,
} from '@shared/organize';
import { parseIpc } from './schemas';
import type { IpcContext } from './context';

function ensureIdle(ctx: IpcContext): void {
  if (
    ctx.scan.isBusy() ||
    ctx.deleteService.isRunning() ||
    ctx.video.isRunning() ||
    ctx.archive.isRunning()
  ) {
    throw new Error('请等待扫描、删除或压缩任务完成后再整理或移动');
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
  ipcMain.handle(IPC.organizePreview, async (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.plan(parseIpc(organizePreviewSchema, raw, '整理预览'));
  });
  ipcMain.handle(IPC.organizeSmartPreview, async (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.planSmart(parseIpc(smartOrganizePreviewSchema, raw, '智能归类预览'));
  });
  ipcMain.handle(IPC.organizeStart, (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.start(parseIpc(organizeStartSchema, raw, '移动文件'));
  });
  ipcMain.handle(IPC.organizeState, () => ctx.organize.getState());
  ipcMain.handle(IPC.organizeCancel, () => ctx.organize.cancel());
  ipcMain.handle(IPC.moveDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择移动目标文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.movePreview, async (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.planMove(parseIpc(movePreviewSchema, raw, '移动预览'));
  });
  ipcMain.handle(IPC.moveStart, (_event, raw: unknown) => {
    ensureIdle(ctx);
    return ctx.organize.startMove(parseIpc(moveStartSchema, raw, '移动文件'));
  });
  ipcMain.handle(IPC.moveState, () => ctx.organize.getState());
  ipcMain.handle(IPC.moveCancel, () => ctx.organize.cancel());
}
