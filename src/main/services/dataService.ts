import type { DatabaseSync } from 'node:sqlite';
import type { BackupFileInfo, DataInfo } from '@shared/types';
import fs from 'node:fs';
import type { AppPaths } from '../paths';
import type { BackupService } from './backupService';

export interface DataServiceDeps {
  db: DatabaseSync;
  paths: AppPaths;
  backup: BackupService;
}

export class DataService {
  private readonly db: DatabaseSync;
  private readonly paths: AppPaths;
  private readonly backup: BackupService;

  constructor(deps: DataServiceDeps) {
    this.db = deps.db;
    this.paths = deps.paths;
    this.backup = deps.backup;
  }

  info(): DataInfo {
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.paths.dbPath).size;
    } catch {
      dbSizeBytes = 0;
    }
    return {
      dataDir: this.paths.dataDir,
      dbPath: this.paths.dbPath,
      dbSizeBytes,
      backupDir: this.paths.backupDir,
      backups: this.backup.list(),
    };
  }

  async clear(): Promise<{ backup: BackupFileInfo | null }> {
    const created = await this.backup.create();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM duplicate_runs;
        DELETE FROM hash_cache;
        DELETE FROM scan_staging;
        DELETE FROM files;
        DELETE FROM scans;
        DELETE FROM meta WHERE key = 'active_scan_id';
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Transaction may already be rolled back.
      }
      throw error;
    }
    return { backup: created };
  }
}
