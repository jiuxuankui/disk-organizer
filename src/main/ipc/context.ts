import type { DatabaseSync } from 'node:sqlite';
import type { AppPaths } from '../paths';
import type { SettingsService } from '../services/settingsService';
import type { DrivesService } from '../services/drivesService';
import type { ScanService } from '../services/scanService';
import type { OverviewService } from '../services/overviewService';
import type { DuplicatesService } from '../services/duplicatesService';
import type { DeleteService } from '../services/deleteService';
import type { LongTrashService } from '../services/longTrashService';
import type { BackupService } from '../services/backupService';
import type { DataService } from '../services/dataService';
import type { DevOverrides } from '../devOverrides';
import type { VideoService } from '../services/videoService';

export interface IpcContext {
  video: VideoService;
  paths: AppPaths;
  db: DatabaseSync;
  settings: SettingsService;
  drives: DrivesService;
  scan: ScanService;
  overview: OverviewService;
  duplicates: DuplicatesService;
  deleteService: DeleteService;
  longTrash: LongTrashService;
  backup: BackupService;
  data: DataService;
  devOverrides: DevOverrides;
}
