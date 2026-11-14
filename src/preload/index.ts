import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipcChannels';
import type { DiskOrganizerApi, StartScanInput } from '@shared/api';
import type { AppSettings, DeleteEvent, DuplicateQuery, FileQuery, ScanEvent } from '@shared/types';

const api: DiskOrganizerApi = {
  selectArchiveOutputDir: () => ipcRenderer.invoke(IPC.archiveOutputDir),
  startArchive: (input) => ipcRenderer.invoke(IPC.archiveStart, input),
  getArchiveState: () => ipcRenderer.invoke(IPC.archiveState),
  cancelArchive: () => ipcRenderer.invoke(IPC.archiveCancel),
  selectVideoFiles: () => ipcRenderer.invoke(IPC.videoSelect),
  selectVideoOutputDir: () => ipcRenderer.invoke(IPC.videoOutputDir),
  getVideoState: () => ipcRenderer.invoke(IPC.videoState),
  startVideo: (input) => ipcRenderer.invoke(IPC.videoStart, input),
  cancelVideo: () => ipcRenderer.invoke(IPC.videoCancel),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  listDrives: (refresh = false) => ipcRenderer.invoke(refresh ? IPC.drivesRefresh : IPC.drivesList),
  getOverview: () => ipcRenderer.invoke(IPC.homeOverview),
  queryFiles: (query: FileQuery) => ipcRenderer.invoke(IPC.filesQuery, query),
  listFileIds: (query: FileQuery) => ipcRenderer.invoke(IPC.filesListIds, query),
  getFile: (id: number) => ipcRenderer.invoke(IPC.filesGet, { id }),
  getDuplicatesState: () => ipcRenderer.invoke(IPC.duplicatesState),
  startDuplicates: (drives?: string[]) => ipcRenderer.invoke(IPC.duplicatesStart, { drives }),
  cancelDuplicates: () => ipcRenderer.invoke(IPC.duplicatesCancel),
  queryDuplicateGroups: (query: DuplicateQuery) => ipcRenderer.invoke(IPC.duplicatesGroups, query),
  getScanState: () => ipcRenderer.invoke(IPC.scanGetState),
  startScan: (input: StartScanInput) => ipcRenderer.invoke(IPC.scanStart, input),
  pauseScan: () => ipcRenderer.invoke(IPC.scanPause),
  resumeScan: () => ipcRenderer.invoke(IPC.scanResume),
  cancelScan: () => ipcRenderer.invoke(IPC.scanCancel),
  onScanEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ScanEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC.scanEvent, handler);
    return () => {
      ipcRenderer.removeListener(IPC.scanEvent, handler);
    };
  },
  previewDelete: (fileIds: number[]) => ipcRenderer.invoke(IPC.deletePreview, { fileIds }),
  executeDelete: (fileIds: number[]) => ipcRenderer.invoke(IPC.deleteExecute, { fileIds }),
  cancelDelete: () => ipcRenderer.invoke(IPC.deleteCancel),
  getRecycleStatus: () => ipcRenderer.invoke(IPC.deleteStatus),
  getLongTrash: () => ipcRenderer.invoke(IPC.longTrashList),
  restoreLongTrash: (id: string) => ipcRenderer.invoke(IPC.longTrashRestore, { id }),
  onDeleteEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DeleteEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC.deleteEvent, handler);
    return () => {
      ipcRenderer.removeListener(IPC.deleteEvent, handler);
    };
  },
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  getDataInfo: () => ipcRenderer.invoke(IPC.dataInfo),
  clearData: () => ipcRenderer.invoke(IPC.dataClear),
  listBackups: () => ipcRenderer.invoke(IPC.backupList),
  createBackup: () => ipcRenderer.invoke(IPC.backupCreate).catch(() => null),
  restoreBackup: (path: string) => ipcRenderer.invoke(IPC.backupRestore, { path }),
  openRecycleBin: () => ipcRenderer.invoke(IPC.appOpenRecycleBin),
  openPath: (path: string) => ipcRenderer.invoke(IPC.appOpenPath, { path }),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IPC.appShowItemInFolder, { path }),
  copyText: (text: string) => ipcRenderer.invoke(IPC.appCopyText, { text }),
};

contextBridge.exposeInMainWorld('api', api);
