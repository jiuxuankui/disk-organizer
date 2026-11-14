import type { DatabaseSync } from 'node:sqlite';
import type { AppPaths } from '../paths';
import type { SettingsService } from '../services/settingsService';
import type { DrivesService } from '../services/drivesService';
import type { ScanService } from '../services/scanService';
import type { OverviewService } from '../services/overviewService';
import type { DeleteService } from '../services/deleteService';
import type { LongTrashService } from '../services/longTrashService';
import type { BackupService } from '../services/backupService';
import type { DataService } from '../services/dataService';
import type { DevOverrides } from '../devOverrides';
import type { VideoService } from '../services/videoService';

import type { ArchiveService } from '../services/archiveService';

import type { OrganizeService } from '../services/organizeService';
import type { IndexSyncService } from '../services/indexSyncService';

export interface IpcContext {
  organize: OrganizeService;
  indexSync: IndexSyncService;
  archive: ArchiveService;
  video: VideoService;
  paths: AppPaths;
  db: DatabaseSync;
  settings: SettingsService;
  drives: DrivesService;
  scan: ScanService;
  overview: OverviewService;
  deleteService: DeleteService;
  longTrash: LongTrashService;
  backup: BackupService;
  data: DataService;
  devOverrides: DevOverrides;
}
