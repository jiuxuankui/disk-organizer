import { registerAppIpc } from './app';
import { registerSettingsIpc } from './settings';
import { registerDrivesIpc } from './drives';
import { registerScanIpc } from './scan';
import { registerHomeIpc } from './home';
import { registerFilesIpc } from './files';
import { registerDuplicatesIpc } from './duplicates';
import { registerDeleteIpc } from './delete';
import { registerLongTrashIpc } from './longTrash';
import { registerDataIpc } from './data';
import type { IpcContext } from './context';

export function registerIpc(ctx: IpcContext): void {
  registerAppIpc(ctx);
  registerSettingsIpc(ctx);
  registerDrivesIpc(ctx);
  registerScanIpc(ctx);
  registerHomeIpc(ctx);
  registerFilesIpc(ctx);
  registerDuplicatesIpc(ctx);
  registerDeleteIpc(ctx);
  registerLongTrashIpc(ctx);
  registerDataIpc(ctx);
}
