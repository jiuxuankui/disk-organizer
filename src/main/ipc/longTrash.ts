import { ipcMain } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { LongTrashStatus } from '@shared/types';
import type { IpcContext } from './context';
import { longTrashIdSchema, parseIpc } from './schemas';

export function registerLongTrashIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.longTrashList, (): LongTrashStatus => ctx.longTrash.list());

  ipcMain.handle(
    IPC.longTrashRestore,
    async (_event, raw: unknown): Promise<{ ok: boolean; error: string | null }> => {
      const payload = parseIpc(longTrashIdSchema, raw, '还原文件');
      return ctx.longTrash.restore(payload.id);
    },
  );
}
