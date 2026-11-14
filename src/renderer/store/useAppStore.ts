import { create } from 'zustand';
import type {
  AppInfo,
  AppSettings,
  DeleteEvent,
  DeletePreview,
  DeleteProgress,
  DeleteResult,
  DriveInfo,
  FileRecord,
  FileTypeKey,
  HomeOverview,
  RecycleStatus,
  ScanEvent,
  ScanProgress,
} from '@shared/types';
import { popPage, pushPage } from '../lib/back';

export type PageKey = 'overview' | 'files' | 'duplicates' | 'video' | 'organize' | 'settings';

export interface FilesPrefill {
  drive: string | null;
  type: FileTypeKey | null;
  rootPath: string | null;
}

export interface Notice {
  id: number;
  kind: 'success' | 'info' | 'warning' | 'error';
  text: string;
}

const PAGE_KEY = 'disk-organizer:last-page';
const DRIVE_KEY = 'disk-organizer:last-drive';
const INDEX_SYNC_INTERVAL_MS = 15_000;
let lastIndexSyncAt = 0;
const VALID_PAGES: PageKey[] = ['overview', 'files', 'duplicates', 'video', 'organize', 'settings'];

function readPage(): PageKey {
  try {
    const value = localStorage.getItem(PAGE_KEY);
    return VALID_PAGES.includes(value as PageKey) ? (value as PageKey) : 'overview';
  } catch {
    return 'overview';
  }
}

function readDrive(): string | null {
  try {
    return localStorage.getItem(DRIVE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persisting UI preferences is best effort.
  }
}

export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

let noticeSeq = 0;

function notice(kind: Notice['kind'], text: string): Notice {
  noticeSeq += 1;
  return { id: noticeSeq, kind, text };
}

export type DeletePhase = 'idle' | 'preview' | 'running' | 'result';

interface AppState {
  initialized: boolean;
  loading: boolean;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  drives: DriveInfo[];
  overview: HomeOverview | null;
  scanState: ScanProgress | null;
  page: PageKey;
  pageHistory: PageKey[];
  selectedDrive: string | null;
  scanModalOpen: boolean;
  detailFile: FileRecord | null;
  filesPrefill: FilesPrefill;
  videoPaths: string[];
  notice: Notice | null;
  deletePhase: DeletePhase;
  deletePreview: DeletePreview | null;
  deleteProgress: DeleteProgress | null;
  deleteResult: DeleteResult | null;
  deleteTargetIds: number[];
  dataVersion: number;
  recycleStatus: RecycleStatus | null;

  initialize(): Promise<void>;
  setPage(page: PageKey): void;
  goBack(): boolean;
  selectDrive(drive: string): void;
  openScanModal(): void;
  closeScanModal(): void;
  refreshDrives(): Promise<void>;
  refreshOverview(silent?: boolean): Promise<void>;
  refreshRecycleStatus(): Promise<void>;
  syncIndex(force?: boolean): Promise<void>;
  startScan(input: {
    drives: string[];
    excludedPaths?: string[];
    skipHiddenSystem?: boolean;
  }): Promise<boolean>;
  pauseScan(): Promise<void>;
  resumeScan(): Promise<void>;
  cancelScan(): Promise<void>;
  handleScanEvent(event: ScanEvent): void;
  openDetail(file: FileRecord): void;
  closeDetail(): void;
  openInExplorer(path: string): Promise<void>;
  browseToFiles(prefill: Partial<FilesPrefill>): void;
  clearFilesPrefill(): void;
  requestDelete(fileIds: number[]): Promise<void>;
  confirmDelete(): Promise<void>;
  cancelDelete(): Promise<void>;
  closeDeleteResult(): void;
  handleDeleteEvent(event: DeleteEvent): void;
  updateSettings(patch: Partial<AppSettings>): Promise<boolean>;
  clearData(): Promise<boolean>;
  pushNotice(kind: Notice['kind'], text: string): void;
  clearNotice(): void;
}

function pickDrive(overview: HomeOverview | null, previous: string | null): string | null {
  const letters = overview?.drives.map((drive) => drive.drive) ?? [];
  if (previous && letters.includes(previous)) return previous;
  const scanned = overview?.scan?.drives ?? [];
  const fallback = scanned.find((letter) => letters.includes(letter));
  if (fallback) return fallback;
  return overview?.drives.find((drive) => drive.online)?.drive ?? letters[0] ?? null;
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  loading: true,
  appInfo: null,
  settings: null,
  drives: [],
  overview: null,
  scanState: null,
  page: readPage(),
  pageHistory: [],
  selectedDrive: null,
  scanModalOpen: false,
  detailFile: null,
  filesPrefill: { drive: null, type: null, rootPath: null },
  videoPaths: [],
  notice: null,
  deletePhase: 'idle',
  deletePreview: null,
  deleteProgress: null,
  deleteResult: null,
  deleteTargetIds: [],
  dataVersion: 0,
  recycleStatus: null,

  async initialize() {
    if (get().initialized) return;
    set({ initialized: true, loading: true });
    try {
      const [appInfo, settings, drives, scanState, overview, recycleStatus] = await Promise.all([
        window.api.getAppInfo(),
        window.api.getSettings(),
        window.api.listDrives(true),
        window.api.getScanState(),
        window.api.getOverview(),
        window.api.getRecycleStatus().catch(() => null),
      ]);
      set({
        appInfo,
        settings,
        drives,
        scanState,
        overview,
        recycleStatus,
        selectedDrive: pickDrive(overview, readDrive()),
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        notice: notice('error', `初始化失败：${describeError(error)}`),
      });
    }
  },

  setPage(page) {
    writeStorage(PAGE_KEY, page);
    const next = pushPage({ page: get().page, history: get().pageHistory }, page);
    set({ page: next.page, pageHistory: next.history });
  },

  goBack() {
    const next = popPage({ page: get().page, history: get().pageHistory });
    if (next.page === get().page) return false;
    writeStorage(PAGE_KEY, next.page);
    set({ page: next.page, pageHistory: next.history });
    return true;
  },

  selectDrive(drive) {
    writeStorage(DRIVE_KEY, drive);
    set({ selectedDrive: drive });
  },

  openScanModal() {
    set({ scanModalOpen: true });
    void get().refreshDrives();
  },

  closeScanModal() {
    set({ scanModalOpen: false });
  },

  async refreshDrives() {
    try {
      set({ drives: await window.api.listDrives(true) });
    } catch (error) {
      set({ notice: notice('error', `刷新硬盘失败：${describeError(error)}`) });
    }
  },

  async refreshOverview(silent = false) {
    try {
      const overview = await window.api.getOverview();
      const selectedDrive = pickDrive(overview, get().selectedDrive);
      if (selectedDrive) writeStorage(DRIVE_KEY, selectedDrive);
      set({ overview, selectedDrive });
    } catch (error) {
      if (!silent) {
        set({ notice: notice('error', `读取总览失败：${describeError(error)}`) });
      }
    }
  },

  async refreshRecycleStatus() {
    try {
      set({ recycleStatus: await window.api.getRecycleStatus() });
    } catch {
      // Status is advisory; deletion previews still fail closed in the main process.
    }
  },

  async syncIndex(force = false) {
    if (!force && Date.now() - lastIndexSyncAt < INDEX_SYNC_INTERVAL_MS) return;
    try {
      const result = await window.api.syncIndex();
      if (result.skipped) return;
      lastIndexSyncAt = Date.now();
      if (result.removed === 0) return;
      set({ dataVersion: get().dataVersion + 1 });
      const detail = get().detailFile;
      if (detail) {
        const current = await window.api.getFile(detail.id).catch(() => null);
        if (!current && get().detailFile?.id === detail.id) set({ detailFile: null });
      }
      await get().refreshOverview(true);
      set({
        notice: notice(
          'info',
          `已自动同步磁盘变化：${result.removed} 个文件已不在原位置，已从索引移除`,
        ),
      });
    } catch {
      // Synchronizing with the disk is best effort; the next focus retries it.
    }
  },

  async startScan(input) {
    try {
      const scanState = await window.api.startScan(input);
      set({ scanState, scanModalOpen: false });
      return true;
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
      return false;
    }
  },

  async pauseScan() {
    try {
      set({ scanState: await window.api.pauseScan() });
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
    }
  },

  async resumeScan() {
    try {
      set({ scanState: await window.api.resumeScan() });
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
    }
  },

  async cancelScan() {
    try {
      set({ scanState: await window.api.cancelScan() });
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
    }
  },

  handleScanEvent(event) {
    if (event.type === 'state') {
      set({ scanState: event.state });
      return;
    }
    if (event.type === 'completed') {
      set({
        notice: notice(
          'success',
          `扫描完成：识别 ${event.scan.totalFiles.toLocaleString('zh-CN')} 个文件`,
        ),
      });
      void get().refreshOverview(true);
      void get().refreshDrives();
      void get().refreshRecycleStatus();
      return;
    }
    if (event.type === 'cancelled') {
      set({ notice: notice('info', '已取消扫描，旧数据保持不变') });
      return;
    }
    set({ notice: notice('error', `扫描失败：${event.message}`) });
    void get().refreshOverview(true);
  },

  openDetail(file) {
    set({ detailFile: file });
  },

  closeDetail() {
    set({ detailFile: null });
  },

  async openInExplorer(path) {
    try {
      await window.api.showItemInFolder(path);
    } catch (error) {
      set({ notice: notice('error', `无法打开位置：${describeError(error)}`) });
    }
  },

  browseToFiles(prefill) {
    const next = pushPage({ page: get().page, history: get().pageHistory }, 'files');
    set({
      filesPrefill: {
        drive: prefill.drive ?? null,
        type: prefill.type ?? null,
        rootPath: prefill.rootPath ?? null,
      },
      page: next.page,
      pageHistory: next.history,
    });
    writeStorage(PAGE_KEY, 'files');
  },

  clearFilesPrefill() {
    set({ filesPrefill: { drive: null, type: null, rootPath: null } });
  },

  async requestDelete(fileIds) {
    const ids = [...new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return;
    const recycle = get().recycleStatus;
    if (recycle && !recycle.available) {
      set({
        notice: notice('warning', recycle.reason ?? 'Windows 回收站当前不可用，删除功能已暂停'),
      });
      return;
    }
    try {
      const preview = await window.api.previewDelete(ids);
      set({
        deletePhase: 'preview',
        deletePreview: preview,
        deleteTargetIds: ids,
        deleteProgress: null,
        deleteResult: null,
      });
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
    }
  },

  async confirmDelete() {
    const ids = get().deleteTargetIds;
    if (ids.length === 0) return;
    set({
      deletePhase: 'running',
      deletePreview: null,
      deleteResult: null,
      deleteProgress: {
        status: 'running',
        total: ids.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        bytes: 0,
        quarantined: 0,
        currentPath: '',
        startedAt: Date.now(),
        finishedAt: null,
        result: null,
      },
    });
    try {
      const state = await window.api.executeDelete(ids);
      if (state.status === 'running') set({ deleteProgress: state });
    } catch (error) {
      set({
        deletePhase: 'idle',
        deleteProgress: null,
        deleteResult: null,
        deleteTargetIds: [],
        notice: notice('error', describeError(error)),
      });
    }
  },

  async cancelDelete() {
    try {
      set({ deleteProgress: await window.api.cancelDelete() });
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
    }
  },

  closeDeleteResult() {
    set({
      deletePhase: 'idle',
      deletePreview: null,
      deleteProgress: null,
      deleteResult: null,
      deleteTargetIds: [],
    });
  },

  handleDeleteEvent(event) {
    if (event.type === 'state') {
      set({ deleteProgress: event.state });
      return;
    }
    const detail = get().detailFile;
    const removedDetail = detail ? get().deleteTargetIds.includes(detail.id) : false;
    set({
      deletePhase: 'result',
      deleteProgress: event.state,
      deleteResult: event.result,
      deleteTargetIds: [],
      dataVersion: get().dataVersion + 1,
      detailFile: removedDetail ? null : detail,
    });
    void get().refreshOverview(true);
    void get().refreshRecycleStatus();
  },

  async updateSettings(patch) {
    try {
      const settings = await window.api.updateSettings(patch);
      set({ settings });
      return true;
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
      return false;
    }
  },

  async clearData() {
    try {
      await window.api.clearData();
      set({
        dataVersion: get().dataVersion + 1,
        detailFile: null,
        deletePhase: 'idle',
        deletePreview: null,
        deleteProgress: null,
        deleteResult: null,
        deleteTargetIds: [],
        scanState: await window.api.getScanState().catch(() => null),
      });
      await get().refreshOverview(true);
      void get().refreshRecycleStatus();
      set({ notice: notice('success', '已清空扫描数据，设置和最新备份已保留') });
      return true;
    } catch (error) {
      set({ notice: notice('error', describeError(error)) });
      return false;
    }
  },

  pushNotice(kind, text) {
    set({ notice: notice(kind, text) });
  },

  clearNotice() {
    set({ notice: null });
  },
}));

export function isScanActive(scan: ScanProgress | null): boolean {
  if (!scan) return false;
  return (
    scan.status === 'enumerating' ||
    scan.status === 'indexing' ||
    scan.status === 'paused' ||
    scan.status === 'committing'
  );
}
