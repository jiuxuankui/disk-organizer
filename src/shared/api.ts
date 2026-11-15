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
  DuplicateMode,
  DuplicateQuery,
  DuplicatesState,
  FileQuery,
  FileRecord,
  FolderContents,
  FolderFacet,
  FolderQuery,
  HomeOverview,
  IndexSyncResult,
  LongTrashStatus,
  PagedResult,
  RecycleStatus,
  ScanEvent,
  ScanProgress,
} from './types';
import type { VideoRequest, VideoState } from './video';
import type { ArchiveRequest, ArchiveState } from './archive';
import type {
  MovePreview,
  MovePreviewRequest,
  MoveStartRequest,
  OrganizePreview,
  OrganizePreviewRequest,
  OrganizeStartRequest,
  OrganizeState,
  SmartOrganizePreviewRequest,
} from './organize';

export interface StartScanInput {
  drives: string[];
  excludedPaths?: string[];
  skipHiddenSystem?: boolean;
}

export interface OpenPathResult {
  ok: boolean;
  error: string | null;
}

export interface DuplicateStartInput {
  drives?: string[];
  folders?: string[];
  mode: DuplicateMode;
}

export interface DiskOrganizerApi {
  selectOrganizeDirectory(): Promise<string | null>;
  previewOrganize(input: OrganizePreviewRequest): Promise<OrganizePreview>;
  previewSmartOrganize(input: SmartOrganizePreviewRequest): Promise<OrganizePreview>;
  startOrganize(input: OrganizeStartRequest): Promise<OrganizeState>;
  getOrganizeState(): Promise<OrganizeState>;
  cancelOrganize(): Promise<OrganizeState>;
  selectMoveDirectory(): Promise<string | null>;
  previewMove(input: MovePreviewRequest): Promise<MovePreview>;
  startMove(input: MoveStartRequest): Promise<OrganizeState>;
  getMoveState(): Promise<OrganizeState>;
  cancelMove(): Promise<OrganizeState>;
  selectArchiveOutputDir(): Promise<string | null>;
  startArchive(input: ArchiveRequest): Promise<ArchiveState>;
  getArchiveState(): Promise<ArchiveState>;
  cancelArchive(): Promise<ArchiveState>;
  selectVideoFiles(): Promise<string[]>;
  selectVideoOutputDir(): Promise<string | null>;
  getVideoState(): Promise<VideoState>;
  startVideo(input: VideoRequest): Promise<VideoState>;
  cancelVideo(): Promise<VideoState>;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  listDrives(refresh?: boolean): Promise<DriveInfo[]>;
  getOverview(): Promise<HomeOverview>;
  queryFiles(query: FileQuery): Promise<PagedResult<FileRecord>>;
  listFileIds(query: FileQuery): Promise<number[]>;
  listFileFolders(query: FolderQuery): Promise<FolderFacet[]>;
  listFolderContents(query: FolderQuery): Promise<FolderContents>;
  getFile(id: number): Promise<FileRecord | null>;
  syncIndex(): Promise<IndexSyncResult>;
  selectDuplicateDirectory(): Promise<string | null>;
  getDuplicatesState(): Promise<DuplicatesState>;
  startDuplicates(input: DuplicateStartInput): Promise<DuplicatesState>;
  cancelDuplicates(): Promise<DuplicatesState>;
  queryDuplicateGroups(query: DuplicateQuery): Promise<DuplicateGroupPage>;
  getScanState(): Promise<ScanProgress>;
  startScan(input: StartScanInput): Promise<ScanProgress>;
  pauseScan(): Promise<ScanProgress>;
  resumeScan(): Promise<ScanProgress>;
  cancelScan(): Promise<ScanProgress>;
  onScanEvent(listener: (event: ScanEvent) => void): () => void;
  previewDelete(fileIds: number[], folderPaths?: string[]): Promise<DeletePreview>;
  executeDelete(fileIds: number[], folderPaths?: string[]): Promise<DeleteProgress>;
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
  onBackCommand(listener: () => void): () => void;
}
