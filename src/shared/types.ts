export type FileTypeKey =
  | 'video'
  | 'image'
  | 'document'
  | 'audio'
  | 'archive'
  | 'installer'
  | 'diskImage'
  | 'program'
  | 'other';

export type ScanStatus =
  | 'idle'
  | 'enumerating'
  | 'indexing'
  | 'committing'
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'failed';

export interface DriveInfo {
  letter: string;
  root: string;
  label: string;
  fileSystem: string;
  serial: string;
  totalBytes: number;
  freeBytes: number;
  type: number;
  ready: boolean;
}

export interface SkippedSample {
  path: string;
  reason: SkipReason;
  detail?: string;
}

export type SkipReason = 'permission' | 'excluded' | 'hidden' | 'system' | 'special' | 'error';

export interface SkippedSummary {
  reason: SkipReason;
  count: number;
  samples: string[];
}

export interface ScanOptions {
  drives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
}

export interface ScanProgress {
  scanId: number | null;
  status: ScanStatus;
  phase: 'idle' | 'enumerating' | 'indexing' | 'committing';
  drives: string[];
  currentPath: string;
  filesFound: number;
  filesProcessed: number;
  bytesProcessed: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface ScanSummary {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: ScanStatus;
  drives: string[];
  totalFiles: number;
  identifiedBytes: number;
  skipped: SkippedSummary[];
}

export interface FileRecord {
  id: number;
  drive: string;
  path: string;
  name: string;
  ext: string;
  type: FileTypeKey;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  rootDir: string;
  dirPath: string;
}

export interface FileQuery {
  drive?: string | null;
  type?: FileTypeKey | 'all' | null;
  minSize?: number | null;
  maxSize?: number | null;
  mtimeFrom?: number | null;
  mtimeTo?: number | null;
  rootDir?: string | null;
  dirPath?: string | null;
  dirPrefix?: string | null;
  search?: string;
  sortBy: 'size' | 'mtime' | 'name' | 'type';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  totalBytes: number;
  page: number;
  pageSize: number;
}

export interface TypeUsage {
  type: FileTypeKey;
  bytes: number;
  count: number;
}

export interface FolderUsage {
  path: string;
  name: string;
  bytes: number;
  count: number;
}

export interface FolderFacet {
  drive: string;
  path: string;
  name: string;
  bytes: number;
  count: number;
}

export interface FolderQuery {
  parentDir?: string | null;
  drive?: string | null;
  search?: string;
  minSize?: number | null;
  maxSize?: number | null;
  mtimeFrom?: number | null;
  mtimeTo?: number | null;
}

export interface FolderContents {
  folders: FolderFacet[];
  files: FileRecord[];
  totalFiles: number;
}

export interface DriveOverview {
  drive: string;
  label: string;
  fileSystem: string;
  online: boolean;
  totalBytes: number;
  freeBytes: number;
  identifiedBytes: number;
  unidentifiedBytes: number;
  fileCount: number;
  typeUsage: TypeUsage[];
  topFiles: FileRecord[];
  topFolders: FolderUsage[];
}

export interface HomeOverview {
  scan: ScanSummary | null;
  drives: DriveOverview[];
  totalIdentifiedBytes: number;
  totalFiles: number;
}

export interface AppSettings {
  organizeRules: import('./organize').OrganizeRule[];
  organizePriority: import('./organize').OrganizePriority;
  scanDrives: string[];
  excludedPaths: string[];
  skipHiddenSystem: boolean;
  autoBackup: boolean;
  theme: import('./themes').ThemeId;
}

export type ScanEvent =
  | { type: 'state'; state: ScanProgress }
  | { type: 'completed'; scan: ScanSummary }
  | { type: 'cancelled'; scanId: number }
  | { type: 'failed'; message: string };

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  platform: string;
  dataDir: string;
  backupDir: string;
}

export type DeleteItemStatus = 'ok' | 'longPath' | 'missing' | 'trashUnavailable' | 'tooLarge';

export interface DeletePreview {
  total: number;
  okCount: number;
  okBytes: number;
  longPathCount: number;
  longPathBytes: number;
  missingCount: number;
  blockedCount: number;
  previewNames: string[];
  folderOkCount: number;
  folderOkFileCount: number;
  folderOkBytes: number;
  folderNames: string[];
  fileNames: string[];
  blockedMessage: string | null;
  recycleAvailable: boolean;
  recycleMessage: string | null;
  canDelete: boolean;
}

export interface DeleteFailure {
  fileId: number;
  path: string;
  name: string;
  reason: string;
  kind?: 'file' | 'folder';
}

export interface DeleteResult {
  succeeded: number;
  failed: number;
  bytes: number;
  quarantined: number;
  quarantineBytes: number;
  foldersSucceeded: number;
  folderFileCount: number;
  folderBytes: number;
  failures: DeleteFailure[];
  stopped: boolean;
}

export interface DeleteProgress {
  status: 'idle' | 'running' | 'completed';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  bytes: number;
  quarantined: number;
  foldersSucceeded: number;
  folderFileCount: number;
  folderBytes: number;
  currentPath: string;
  startedAt: number | null;
  finishedAt: number | null;
  result: DeleteResult | null;
}

export type DeleteEvent =
  | { type: 'state'; state: DeleteProgress }
  | { type: 'settled'; state: DeleteProgress; result: DeleteResult };

export interface LongTrashEntry {
  id: string;
  originalPath: string;
  name: string;
  size: number;
  drive: string;
  storedPath: string;
  deletedAt: number;
}

export interface LongTrashStatus {
  entries: LongTrashEntry[];
  totalBytes: number;
  manifestPath: string;
}

export interface RecycleDriveStatus {
  drive: string;
  available: boolean;
  reason: string | null;
  maxCapacityBytes: number;
}

export interface RecycleStatus {
  available: boolean;
  reason: string | null;
  drives: RecycleDriveStatus[];
}

export interface BackupFileInfo {
  fileName: string;
  path: string;
  createdAt: number;
  sizeBytes: number;
  settingsPath: string | null;
}

export interface DataInfo {
  dataDir: string;
  dbPath: string;
  dbSizeBytes: number;
  backupDir: string;
  backups: BackupFileInfo[];
}

export interface ClearDataResult {
  backup: BackupFileInfo | null;
}

export interface IndexSyncResult {
  removed: number;
  checked: number;
  skipped: boolean;
}
