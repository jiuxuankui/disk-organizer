import { app, BrowserWindow, dialog, session, shell } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { VideoService } from './services/videoService';
import { ArchiveService } from './services/archiveService';
import type { DeleteEvent, ScanEvent } from '@shared/types';
import { IPC } from '@shared/ipcChannels';
import { createMainWindow } from './window';
import { ensureAppDirs, resolveAppPaths, type AppPaths } from './paths';
import { registerIpc } from './ipc';
import { DatabaseCorruptError, openDatabase, closeDatabaseQuietly } from './db/connection';
import { SchemaTooNewError } from './db/migrate';
import { SettingsService } from './services/settingsService';
import { DrivesService } from './services/drivesService';
import { ScanService } from './services/scanService';
import { OverviewService } from './services/overviewService';
import { DuplicatesService } from './services/duplicatesService';
import { DeleteService } from './services/deleteService';
import { LongTrashService } from './services/longTrashService';
import { BackupService, quarantineDatabase } from './services/backupService';
import { DataService } from './services/dataService';
import { readRecycleBinPolicy } from './services/recycleBinService';
import { createFakeRecyclePolicy, createFakeTrashItem, readDevOverrides } from './devOverrides';
import { createScanWorker } from './services/scanWorkerFactory';
import { createHashRunner } from './services/hashWorkerFactory';

function formatBackupTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

function openDatabaseWithRecovery(paths: AppPaths): DatabaseSync | null {
  try {
    return openDatabase(paths.dbPath);
  } catch (error) {
    const corrupt = error instanceof DatabaseCorruptError;
    const tooNew = error instanceof SchemaTooNewError;
    if (!corrupt && !tooNew) throw error;

    const backupFiles = new BackupService({
      dbPath: paths.dbPath,
      backupDir: paths.backupDir,
      settingsPath: paths.settingsPath,
    });
    const latest = backupFiles.latestValid();
    const buttons = latest
      ? ['从最近备份恢复', '重新扫描（保留损坏文件）', '退出']
      : ['重新扫描（保留损坏文件）', '退出'];
    const detail = [
      error instanceof Error ? error.message : String(error),
      latest
        ? `最近备份：${formatBackupTime(latest.createdAt)}（${(latest.sizeBytes / 1024 / 1024).toFixed(1)} MB）`
        : '没有可用的自动备份。',
      '重新扫描会保留损坏文件副本，并在软件内回到未扫描状态。',
    ].join('\n\n');
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '本地数据无法读取',
      message: tooNew ? '数据来自更新版本的软件' : '索引数据库已损坏或无法读取',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });

    if (latest && choice === 0) {
      try {
        backupFiles.copyIntoPlace(latest);
      } catch (restoreError) {
        dialog.showErrorBox(
          '从备份恢复失败',
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        );
        return null;
      }
      return openDatabase(paths.dbPath);
    }
    if ((latest && choice === 1) || (!latest && choice === 0)) {
      try {
        if (fs.existsSync(paths.dbPath)) quarantineDatabase(paths.dbPath);
      } catch (quarantineError) {
        dialog.showErrorBox(
          '无法重建索引数据库',
          quarantineError instanceof Error ? quarantineError.message : String(quarantineError),
        );
        return null;
      }
      return openDatabase(paths.dbPath);
    }
    return null;
  }
}

const paths = resolveAppPaths();

app.setPath('userData', paths.rootDir);
app.setPath('sessionData', paths.rootDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let db: DatabaseSync | null = null;
  let scan: ScanService | null = null;
  let duplicates: DuplicatesService | null = null;
  let deleteService: DeleteService | null = null;
  let video: VideoService | null = null;
  let archive: ArchiveService | null = null;
  let quittingAfterScan = false;
  let closeConfirmed = false;

  function broadcastScanEvent(event: ScanEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.scanEvent, event);
    }
  }

  function broadcastDeleteEvent(event: DeleteEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.deleteEvent, event);
    }
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    try {
      ensureAppDirs(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        '无法创建本地数据目录',
        `${message}\n\n数据目录：${paths.rootDir}\n请确认该目录可写，然后重新启动软件。`,
      );
      app.quit();
      return;
    }

    try {
      db = openDatabaseWithRecovery(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        '无法打开本地数据',
        `${message}\n\n数据目录：${paths.dataDir}\n请确认该目录可写，然后重新启动软件。`,
      );
      app.quit();
      return;
    }
    if (!db) {
      app.quit();
      return;
    }

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*",
          ],
        },
      });
    });

    const settings = new SettingsService(paths.settingsPath);
    settings.load();
    const drives = new DrivesService();
    const scanService = new ScanService({
      db,
      dbPath: paths.dbPath,
      workerFactory: createScanWorker,
      emit: broadcastScanEvent,
    });
    scanService.recover();
    scan = scanService;

    const overview = new OverviewService({ db, drives });
    const duplicatesService = new DuplicatesService({
      db,
      getDefaultMinSize: () => settings.get().minDuplicateSize,
      runnerFactory: createHashRunner,
    });
    duplicatesService.recover();
    duplicates = duplicatesService;

    const backupService = new BackupService({
      db,
      dbPath: paths.dbPath,
      backupDir: paths.backupDir,
      settingsPath: paths.settingsPath,
    });
    const devOverrides = readDevOverrides();
    const fakePolicy = createFakeRecyclePolicy();
    const longTrash = new LongTrashService({ rootDir: paths.rootDir });
    const deleteSvc = new DeleteService({
      db,
      getRecyclePolicy: devOverrides.fakeTrashDir ? () => fakePolicy : readRecycleBinPolicy,
      trashItem: devOverrides.fakeTrashDir
        ? createFakeTrashItem(devOverrides.fakeTrashDir)
        : (filePath) => shell.trashItem(filePath),
      longTrash,
      emit: broadcastDeleteEvent,
    });
    deleteService = deleteSvc;
    const dataService = new DataService({ db, paths, backup: backupService });

    const videoService = new VideoService({
      toolsDir: app.isPackaged
        ? path.join(process.resourcesPath, 'ffmpeg')
        : path.join(app.getAppPath(), 'build', 'ffmpeg'),
      fixedDriveLetters: () => drives.onlineLetters(),
    });
    video = videoService;

    const archiveService = new ArchiveService(() => drives.onlineLetters());
    archive = archiveService;

    registerIpc({
      archive: archiveService,
      video: videoService,
      paths,
      db,
      settings,
      drives,
      scan: scanService,
      overview,
      duplicates: duplicatesService,
      deleteService: deleteSvc,
      longTrash,
      backup: backupService,
      data: dataService,
      devOverrides,
    });

    mainWindow = createMainWindow();

    mainWindow.on('close', (event) => {
      const compressing = videoService.isRunning() || archiveService.isRunning();
      if (closeConfirmed || (!scanService.isScanning() && !compressing)) return;
      const window = mainWindow;
      if (!window) return;
      const choice = dialog.showMessageBoxSync(window, {
        type: 'warning',
        title: compressing ? '压缩任务尚未完成' : '扫描尚未完成',
        message: compressing ? '关闭将停止当前压缩任务。' : '扫描尚未完成，关闭将丢失本次进度。',
        detail: compressing
          ? '原文件和已完成的输出保留，仅清理本次未完成的临时文件。'
          : '本次未完成的扫描结果不会保存，已有旧数据保持不变。',
        buttons: ['取消', '关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice !== 1) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      closeConfirmed = true;
      scanService.cancel();
      videoService.cancel();
      archiveService.cancel();
      void Promise.all([
        scanService.whenIdle(),
        videoService.whenIdle(),
        archiveService.whenIdle(),
      ]).finally(() => {
        mainWindow?.close();
      });
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });

    if (process.env.DISK_ORGANIZER_SMOKE_EXIT === '1') {
      mainWindow.webContents.once('did-finish-load', () => {
        console.log('SMOKE_WINDOW_LOADED');
        setTimeout(() => app.quit(), 800);
      });
      setTimeout(() => {
        console.error('SMOKE_WINDOW_TIMEOUT');
        app.exit(2);
      }, 20000);
    }
  });

  app.on('before-quit', (event) => {
    if (
      (scan?.isBusy() ||
        duplicates?.isRunning() ||
        deleteService?.isRunning() ||
        video?.isRunning() ||
        archive?.isRunning()) &&
      !quittingAfterScan
    ) {
      event.preventDefault();
      quittingAfterScan = true;
      scan?.cancel();
      duplicates?.cancel();
      deleteService?.cancel();
      video?.cancel();
      archive?.cancel();
      void Promise.all([
        scan?.whenIdle(),
        duplicates?.whenIdle(),
        deleteService?.whenIdle(),
        video?.whenIdle(),
        archive?.whenIdle(),
      ])
        .catch(() => undefined)
        .finally(() => app.quit());
      return;
    }
    if (db) {
      closeDatabaseQuietly(db);
      db = null;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
