import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { HomeOverview } from '@shared/types';
import type { IpcContext } from './context';

export function registerHomeIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.homeOverview, (): HomeOverview => ctx.overview.get());
}
