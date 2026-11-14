import { app, dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { BackupFileInfo, ClearDataResult, DataInfo } from '@shared/types';
import { closeDatabaseQuietly } from '../db/connection';
import { getActiveScanId } from '../db/scansRepo';
import type { IpcContext } from './context';
import { parseIpc, pathSchema } from './schemas';

function ensureIdle(ctx: IpcContext, label: string): void {
  if (ctx.video.isRunning()) throw new Error(`视频压缩进行中，完成或取消后再${label}`);
  if (ctx.scan.isBusy()) throw new Error(`扫描进行中，完成后再${label}`);
  if (ctx.duplicates.isRunning()) throw new Error(`重复文件查找进行中，完成或取消后再${label}`);
  if (ctx.deleteService.isRunning()) throw new Error(`删除进行中，完成后再${label}`);
}

export function registerDataIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.backupList, (): BackupFileInfo[] => ctx.backup.list());

  ipcMain.handle(IPC.backupCreate, async (): Promise<BackupFileInfo> => {
    if (ctx.scan.isBusy()) throw new Error('扫描进行中，完成后再备份');
    return ctx.backup.create();
  });

  ipcMain.handle(IPC.backupRestore, async (_event, raw: unknown): Promise<{ ok: boolean }> => {
    const { path } = parseIpc(pathSchema, raw, '从备份恢复');
    ensureIdle(ctx, '恢复备份');
    const entry = ctx.backup.list().find((item) => item.path === path);
    if (!entry) throw new Error('只能从软件自动备份列表中选择备份');
    const check = ctx.backup.validate(entry.path);
    if (!check.ok) throw new Error(check.error);

    const safety = getActiveScanId(ctx.db) === null ? null : await ctx.backup.create();
    closeDatabaseQuietly(ctx.db);
    try {
      ctx.backup.copyIntoPlace(entry);
    } catch (error) {
      try {
        if (safety) ctx.backup.copyIntoPlace(safety);
      } catch {
        // The safety backup remains on disk for manual recovery.
      }
      dialog.showErrorBox(
        '恢复备份失败',
        `${error instanceof Error ? error.message : String(error)}\n\n已尽力保留原数据，软件将重新启动。`,
      );
    }
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 400);
    return { ok: true };
  });

  ipcMain.handle(IPC.dataInfo, (): DataInfo => ctx.data.info());

  ipcMain.handle(IPC.dataClear, async (): Promise<ClearDataResult> => {
    ensureIdle(ctx, '清空数据');
    const result = await ctx.data.clear();
    return { backup: result.backup };
  });
}
