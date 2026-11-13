import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { AppSettings } from '@shared/types';
import type { IpcContext } from './context';
import { parseIpc, settingsUpdateSchema, type SettingsUpdatePayload } from './schemas';

export function registerSettingsIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.settingsGet, (): AppSettings => ctx.settings.get());

  ipcMain.handle(IPC.settingsUpdate, (_event, raw: unknown): AppSettings => {
    const patch: SettingsUpdatePayload = parseIpc(settingsUpdateSchema, raw, '保存设置');
    return ctx.settings.update(patch);
  });
}
