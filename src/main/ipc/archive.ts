import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import { getActiveScanId } from '../db/scansRepo';
import { getFileById } from '../db/filesRepo';
import { archiveStartSchema, parseIpc } from './schemas';
import type { IpcContext } from './context';

export function registerArchiveIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.archiveOutputDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择压缩包输出文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.archiveState, () => ctx.archive.getState());
  ipcMain.handle(IPC.archiveCancel, () => ctx.archive.cancel());
  ipcMain.handle(IPC.archiveStart, (_event, raw: unknown) => {
    const input = parseIpc(archiveStartSchema, raw, '压缩打包');
    if (ctx.organize.isRunning()) throw new Error('文件整理进行中，请完成或停止后再打包');
    if (
      ctx.scan.isBusy() ||
      ctx.deleteService.isRunning() ||
      ctx.video.isRunning()
    ) {
      throw new Error('请等待扫描、重复查找、删除或视频压缩结束后再打包');
    }
    const scanId = getActiveScanId(ctx.db);
    if (scanId === null) throw new Error('请先扫描文件');
    const sources = [...new Set(input.fileIds)].map((id) => {
      const file = getFileById(ctx.db, scanId, id);
      if (!file) throw new Error('所选文件已不在当前索引中，请重新选择');
      return file;
    });
    return ctx.archive.start({ ...input, sources });
  });
}
