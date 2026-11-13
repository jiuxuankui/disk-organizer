import { app, clipboard, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { IPC } from '@shared/ipcChannels';
import type { AppInfo } from '@shared/types';
import type { IpcContext } from './context';
import { toExtendedPath } from '../services/filesystem';
import { copyTextSchema, parseIpc, pathSchema } from './schemas';

function openRecycleBin(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('explorer.exe', ['shell:RecycleBinFolder'], (error) => {
      resolve(error ? error.message : null);
    });
  });
}

export function registerAppIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      dataDir: ctx.paths.dataDir,
      backupDir: ctx.paths.backupDir,
    };
  });

  ipcMain.handle(IPC.appOpenPath, async (_event, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
    const { path } = parseIpc(pathSchema, raw, '打开位置');
    const error = await shell.openPath(path);
    return { ok: error === '', error: error || null };
  });

  ipcMain.handle(IPC.appShowItemInFolder, (_event, raw: unknown): void => {
    const { path } = parseIpc(pathSchema, raw, '定位文件');
    if (!fs.existsSync(toExtendedPath(path))) {
      throw new Error('文件已不存在，或所在硬盘当前未连接');
    }
    shell.showItemInFolder(path);
  });

  ipcMain.handle(IPC.appCopyText, (_event, raw: unknown): void => {
    const { text } = parseIpc(copyTextSchema, raw, '复制文本');
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC.appOpenRecycleBin, async (): Promise<{ ok: boolean; error: string | null }> => {
    const error = await openRecycleBin();
    return { ok: error === null, error };
  });
}
