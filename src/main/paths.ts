import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface AppPaths {
  rootDir: string;
  dataDir: string;
  backupDir: string;
  logsDir: string;
  dbPath: string;
  settingsPath: string;
}

export function resolveAppPaths(): AppPaths {
  const override = process.env.DISK_ORGANIZER_DATA_DIR;
  const rootDir = override
    ? path.resolve(override)
    : path.join(
        process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
        'DiskOrganizer',
      );
  const dataDir = path.join(rootDir, 'data');
  return {
    rootDir,
    dataDir,
    backupDir: path.join(dataDir, 'backup'),
    logsDir: path.join(rootDir, 'logs'),
    dbPath: path.join(dataDir, 'index.db'),
    settingsPath: path.join(dataDir, 'settings.json'),
  };
}

export function ensureAppDirs(paths: AppPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.backupDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
}
