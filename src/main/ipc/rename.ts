import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import {
  renameInspectSchema,
  renamePickSchema,
  renamePreviewSchema,
  renameStartSchema,
  type RenamePickKind,
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

function dialogTitle(kind: RenamePickKind): string {
  return kind === 'folder' ? '选择要重命名的文件夹' : '选择要重命名的文件';
}

export function registerRenameIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.renamePickItems, async (_event, raw: unknown) => {
    const { kind } = parseIpc(renamePickSchema, raw, '选择重命名项目');
    const result = await dialog.showOpenDialog({
      title: dialogTitle(kind),
      properties:
        kind === 'folder'
          ? ['openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return ctx.rename.inspectPaths(result.filePaths).filter((item) => item.kind === kind);
  });

  ipcMain.handle(IPC.renameInspectPaths, (_event, raw: unknown) => {
    const { paths } = parseIpc(renameInspectSchema, raw, '添加拖入项目');
    return ctx.rename.inspectPaths(paths);
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
