import { dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import { IPC } from '@shared/ipcChannels';
import {
  renamePreviewSchema,
  renameStartSchema,
  RENAME_ITEM_LIMIT,
  type RenamePreview,
  type RenameState,
  type RenameUndoInfo,
} from '@shared/rename';
import { parseIpc } from './schemas';
import type { IpcContext } from './context';

function ensureIdle(ctx: IpcContext): void {
  if (ctx.rename.isRunning()) throw new Error('重命名任务进行中，请完成或停止后再操作');
  if (ctx.scan.isBusy()) throw new Error('请等待扫描或旧索引清理结束后再重命名');
  if (ctx.organize.isRunning()) throw new Error('文件整理进行中，请完成或停止后再重命名');
  if (ctx.archive.isRunning()) throw new Error('压缩打包进行中，请完成或取消后再重命名');
  if (ctx.video.isRunning()) throw new Error('视频压缩进行中，请完成或取消后再重命名');
  if (ctx.duplicates.isRunning()) throw new Error('重复文件查找进行中，请完成或取消后再重命名');
  if (ctx.deleteService.isRunning()) throw new Error('删除进行中，请等待完成或先停止');
}

export function registerRenameIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.renamePickItems, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要批量重命名的文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (result.canceled) return [];
    const items: Array<{ path: string; kind: 'file' | 'folder' }> = [];
    for (const filePath of result.filePaths.slice(0, RENAME_ITEM_LIMIT)) {
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) continue;
        items.push({ path: filePath, kind: stat.isDirectory() ? 'folder' : 'file' });
      } catch {
        // 已消失的项目不加入列表。
      }
    }
    return items;
  });

  ipcMain.handle(IPC.renamePreview, (_event, raw: unknown): Promise<RenamePreview> => {
    ensureIdle(ctx);
    return ctx.rename.preview(parseIpc(renamePreviewSchema, raw, '重命名预览'));
  });

  ipcMain.handle(IPC.renameStart, (_event, raw: unknown): RenameState => {
    ensureIdle(ctx);
    const input = parseIpc(renameStartSchema, raw, '批量重命名');
    return ctx.rename.start(input.token);
  });

  ipcMain.handle(IPC.renameState, (): RenameState => ctx.rename.getState());
  ipcMain.handle(IPC.renameCancel, (): RenameState => ctx.rename.cancel());
  ipcMain.handle(IPC.renameUndoInfo, (): RenameUndoInfo | null => ctx.rename.getUndoInfo());
  ipcMain.handle(IPC.renameUndo, (): RenameState => {
    ensureIdle(ctx);
    return ctx.rename.undo();
  });
}
