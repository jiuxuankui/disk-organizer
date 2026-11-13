import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { DriveInfo } from '@shared/types';
import type { IpcContext } from './context';

export function registerDrivesIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.drivesList, (): DriveInfo[] => ctx.drives.list(false));
  ipcMain.handle(IPC.drivesRefresh, (): DriveInfo[] => ctx.drives.refresh());
}
