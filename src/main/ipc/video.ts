import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import { VIDEO_EXTENSIONS } from '@shared/video';
import type { IpcContext } from './context';
import { parseIpc, videoStartSchema } from './schemas';

export function registerVideoIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.videoSelect, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要压缩的视频（原文件始终保留）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: [...VIDEO_EXTENSIONS] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(IPC.videoOutputDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择压缩视频输出文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.videoState, () => ctx.video.getState());
  ipcMain.handle(IPC.videoStart, (_event, raw: unknown) => {
    const input = parseIpc(videoStartSchema, raw, '视频压缩');
    if (ctx.archive.isRunning()) throw new Error('压缩打包进行中，请完成或取消后再压缩视频');
    if (ctx.scan.isBusy() || ctx.duplicates.isRunning() || ctx.deleteService.isRunning()) {
      throw new Error('请等待扫描、重复查找或删除任务结束后再压缩视频');
    }
    return ctx.video.start(input);
  });
  ipcMain.handle(IPC.videoCancel, () => ctx.video.cancel());
}
