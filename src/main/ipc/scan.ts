import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { ScanProgress } from '@shared/types';
import { missingScanRoots } from '../devOverrides';
import type { IpcContext } from './context';
import { parseIpc, scanStartSchema, type ScanStartPayload } from './schemas';

export function registerScanIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.scanGetState, (): ScanProgress => ctx.scan.getState());

  ipcMain.handle(IPC.scanStart, (_event, raw: unknown): ScanProgress => {
    const input: ScanStartPayload = parseIpc(scanStartSchema, raw, '开始扫描');
    if (ctx.archive.isRunning()) throw new Error('压缩打包进行中，请完成或取消后再扫描');
    if (ctx.video.isRunning()) throw new Error('视频压缩进行中，完成或取消后再扫描');
    if (ctx.duplicates.isRunning()) {
      throw new Error('重复文件查找正在进行，完成或取消后才能开始扫描');
    }

    const settings = ctx.settings.get();
    if (ctx.devOverrides.scanRoots) {
      const missing = missingScanRoots(ctx.devOverrides.scanRoots);
      if (missing.length > 0) {
        throw new Error(`测试扫描目录当前不可用：${missing.join('、')}`);
      }
      return ctx.scan.start({
        drives: ctx.devOverrides.scanRoots,
        excludedPaths: input.excludedPaths ?? settings.excludedPaths,
        skipHiddenSystem: input.skipHiddenSystem ?? settings.skipHiddenSystem,
        allowAbsoluteRoots: true,
      });
    }

    const available = ctx.drives.validateScanDrives(input.drives);
    if (available.length === 0) throw new Error('所选硬盘当前不可用，请刷新后重试');

    return ctx.scan.start({
      drives: available.map((drive) => drive.letter),
      excludedPaths: input.excludedPaths ?? settings.excludedPaths,
      skipHiddenSystem: input.skipHiddenSystem ?? settings.skipHiddenSystem,
    });
  });

  ipcMain.handle(IPC.scanPause, (): ScanProgress => {
    ctx.scan.pause();
    return ctx.scan.getState();
  });

  ipcMain.handle(IPC.scanResume, (): ScanProgress => {
    ctx.scan.resume();
    return ctx.scan.getState();
  });

  ipcMain.handle(IPC.scanCancel, (): ScanProgress => {
    ctx.scan.cancel();
    return ctx.scan.getState();
  });
}
