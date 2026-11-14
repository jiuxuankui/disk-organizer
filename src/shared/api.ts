import type {
  AppInfo,
  AppSettings,
  BackupFileInfo,
  ClearDataResult,
  DataInfo,
  DeleteEvent,
  DeletePreview,
  DeleteProgress,
  DriveInfo,
  DuplicateGroupPage,
  DuplicateQuery,
  DuplicatesState,
  FileQuery,
  FileRecord,
  HomeOverview,
  LongTrashStatus,
  PagedResult,
  RecycleStatus,
  ScanEvent,
  ScanProgress,
} from './types';

export interface StartScanInput {
  drives: string[];
  excludedPaths?: string[];
  skipHiddenSystem?: boolean;
}

export interface OpenPathResult {
  ok: boolean;
  error: string | null;
}

export interface DiskOrganizerApi {
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  listDrives(refresh?: boolean): Promise<DriveInfo[]>;
  getOverview(): Promise<HomeOverview>;
  queryFiles(query: FileQuery): Promise<PagedResult<FileRecord>>;
  listFileIds(query: FileQuery): Promise<number[]>;
  getFile(id: number): Promise<FileRecord | null>;
  getDuplicatesState(): Promise<DuplicatesState>;
  startDuplicates(drives?: string[]): Promise<DuplicatesState>;
  cancelDuplicates(): Promise<DuplicatesState>;
  queryDuplicateGroups(query: DuplicateQuery): Promise<DuplicateGroupPage>;
  getScanState(): Promise<ScanProgress>;
  startScan(input: StartScanInput): Promise<ScanProgress>;
  pauseScan(): Promise<ScanProgress>;
  resumeScan(): Promise<ScanProgress>;
  cancelScan(): Promise<ScanProgress>;
  onScanEvent(listener: (event: ScanEvent) => void): () => void;
  previewDelete(fileIds: number[]): Promise<DeletePreview>;
  executeDelete(fileIds: number[]): Promise<DeleteProgress>;
  cancelDelete(): Promise<DeleteProgress>;
  getRecycleStatus(): Promise<RecycleStatus>;
  getLongTrash(): Promise<LongTrashStatus>;
  restoreLongTrash(id: string): Promise<OpenPathResult>;
  onDeleteEvent(listener: (event: DeleteEvent) => void): () => void;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getDataInfo(): Promise<DataInfo>;
  clearData(): Promise<ClearDataResult>;
  listBackups(): Promise<BackupFileInfo[]>;
  createBackup(): Promise<BackupFileInfo | null>;
  restoreBackup(path: string): Promise<{ ok: boolean }>;
  openRecycleBin(): Promise<OpenPathResult>;
  openPath(path: string): Promise<OpenPathResult>;
  showItemInFolder(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
}
