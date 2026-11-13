import type { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import type {
  DeleteEvent,
  DeleteFailure,
  DeletePreview,
  DeleteProgress,
  DeleteResult,
  RecycleStatus,
} from '@shared/types';
import { evaluateRecycleDecision, type RecycleBinPolicy } from './recycleBinService';
import { LONG_PATH_LIMIT } from './longTrashService';
import { getDriveLetter, toExtendedPath } from './filesystem';
import { applyDeletedFileRows, countAllDeletedGroups, listDeleteFileRows } from '../db/deleteRepo';
import { getLatestDuplicateRun } from '../db/duplicatesRepo';
import { getActiveScanId } from '../db/scansRepo';

interface PlannedFile {
  id: number;
  drive: string;
  path: string;
  path_key: string;
  name: string;
  size: number;
  status: 'ok' | 'longPath' | 'missing' | 'trashUnavailable' | 'tooLarge';
  message: string | null;
}

export interface LongTrashPort {
  needsQuarantine(filePath: string): boolean;
  quarantine(filePath: string, meta?: { size?: number; name?: string }): Promise<unknown>;
}

export interface DeleteServiceDeps {
  db: DatabaseSync;
  getRecyclePolicy: (driveRoot: string) => RecycleBinPolicy;
  trashItem: (path: string) => Promise<void>;
  longTrash?: LongTrashPort;
  emit?: (event: DeleteEvent) => void;
  now?: () => number;
  concurrency?: number;
}

const PREVIEW_NAME_LIMIT = 5;

function idleState(): DeleteProgress {
  return {
    status: 'idle',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    bytes: 0,
    quarantined: 0,
    currentPath: '',
    startedAt: null,
    finishedAt: null,
    result: null,
  };
}

function fileExists(filePath: string): boolean {
  try {
    const stats = lstatSync(toExtendedPath(filePath), { throwIfNoEntry: false });
    return Boolean(stats);
  } catch {
    return false;
  }
}

function describeTrashError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return '移到回收站失败';
  if (/ENOENT|找不到|not found|does not exist/i.test(message)) return '文件已不存在';
  if (/EBUSY|EPERM|EACCES|占用|拒绝访问|access is denied/i.test(message)) {
    return '文件被占用或没有权限';
  }
  return message;
}

export class DeleteService {
  private readonly db: DatabaseSync;
  private readonly getRecyclePolicy: (driveRoot: string) => RecycleBinPolicy;
  private readonly trashItem: (path: string) => Promise<void>;
  private readonly longTrash: LongTrashPort | undefined;
  private readonly emitEvent: ((event: DeleteEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly concurrency: number;

  private state: DeleteProgress = idleState();
  private active: Promise<void> | null = null;
  private stopRequested = false;

  constructor(deps: DeleteServiceDeps) {
    this.db = deps.db;
    this.getRecyclePolicy = deps.getRecyclePolicy;
    this.trashItem = deps.trashItem;
    this.longTrash = deps.longTrash;
    this.emitEvent = deps.emit;
    this.now = deps.now ?? Date.now;
    this.concurrency = Math.max(1, Math.min(4, deps.concurrency ?? 2));
  }

  getState(): DeleteProgress {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  cancel(): DeleteProgress {
    if (this.state.status === 'running') {
      this.stopRequested = true;
      this.state = {
        ...this.state,
        currentPath: '',
      };
      this.emit();
    }
    return this.state;
  }

  status(): RecycleStatus {
    const scanId = getActiveScanId(this.db);
    const driveLetters =
      scanId === null
        ? []
        : (
            this.db
              .prepare('SELECT DISTINCT drive FROM files WHERE scan_id = ? ORDER BY drive')
              .all(scanId) as Array<{ drive: string }>
          ).map((row) => row.drive);
    const drives = driveLetters.map((drive) => {
      const policy = this.getRecyclePolicy(`${drive}\\`);
      return {
        drive,
        available: policy.available,
        reason: policy.available ? null : 'Windows 回收站当前不可用，删除功能已暂停',
        maxCapacityBytes: policy.maxCapacityBytes,
      };
    });
    const unavailable = drives.filter((item) => !item.available);
    return {
      available: unavailable.length === 0,
      reason:
        unavailable.length === 0
          ? null
          : `${unavailable.map((item) => item.drive).join('、')} 的回收站当前不可用，删除功能已暂停`,
      drives,
    };
  }

  private plan(fileIds: number[]): PlannedFile[] {
    const scanId = getActiveScanId(this.db);
    if (scanId === null) throw new Error('还没有可用的扫描索引，请先扫描硬盘');
    const unique = [...new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0))];
    const rows = listDeleteFileRows(this.db, scanId, unique);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const policies = new Map<string, RecycleBinPolicy>();
    const usedByDrive = new Map<string, number>();
    const planned: PlannedFile[] = [];

    for (const id of unique) {
      const row = byId.get(id);
      if (!row) {
        planned.push({
          id,
          drive: '',
          path: '',
          path_key: '',
          name: `#${id}`,
          size: 0,
          status: 'missing',
          message: '文件不在当前索引中，请重新扫描后再试',
        });
        continue;
      }
      if (!fileExists(row.path)) {
        planned.push({ ...row, status: 'missing', message: '文件已不存在，可能已被移动或删除' });
        continue;
      }
      if (row.path.length >= LONG_PATH_LIMIT) {
        if (this.longTrash?.needsQuarantine(row.path)) {
          planned.push({
            ...row,
            status: 'longPath',
            message: '路径超过 Windows 回收站支持的 260 字符，将移入软件回收区',
          });
        } else {
          planned.push({
            ...row,
            status: 'trashUnavailable',
            message: '路径超过 Windows 回收站支持的 260 字符，当前无法安全删除',
          });
        }
        continue;
      }
      const driveRoot = `${getDriveLetter(row.path) || row.drive}\\`;
      let policy = policies.get(driveRoot);
      if (!policy) {
        policy = this.getRecyclePolicy(driveRoot);
        policies.set(driveRoot, policy);
      }
      const driveUsed = usedByDrive.get(driveRoot) ?? 0;
      const decision = evaluateRecycleDecision(policy, row.size, driveUsed);
      if (!decision.allowed) {
        planned.push({
          ...row,
          status: decision.reason === 'too-large' ? 'tooLarge' : 'trashUnavailable',
          message: decision.message,
        });
        continue;
      }
      usedByDrive.set(driveRoot, driveUsed + row.size);
      planned.push({ ...row, status: 'ok', message: null });
    }
    return planned;
  }

  preview(fileIds: number[]): DeletePreview {
    const planned = this.plan(fileIds);
    const ok = planned.filter((item) => item.status === 'ok');
    const longPath = planned.filter((item) => item.status === 'longPath');
    const missing = planned.filter((item) => item.status === 'missing');
    const blocked = planned.filter(
      (item) => item.status === 'trashUnavailable' || item.status === 'tooLarge',
    );
    const run = getLatestDuplicateRun(this.db);
    const groupsAllDeleted =
      run && run.status === 'completed'
        ? countAllDeletedGroups(
            this.db,
            run.id,
            planned.map((item) => item.id),
          )
        : 0;
    const recycleBlocked = blocked.filter((item) => item.status === 'trashUnavailable');
    return {
      total: planned.length,
      okCount: ok.length,
      okBytes: ok.reduce((sum, item) => sum + item.size, 0),
      longPathCount: longPath.length,
      longPathBytes: longPath.reduce((sum, item) => sum + item.size, 0),
      missingCount: missing.length,
      blockedCount: blocked.length,
      previewNames: (ok.length > 0 ? ok : longPath.length > 0 ? longPath : planned)
        .slice(0, PREVIEW_NAME_LIMIT)
        .map((item) => item.name),
      groupsAllDeleted,
      recycleAvailable: recycleBlocked.length === 0,
      recycleMessage:
        recycleBlocked.length === 0
          ? null
          : (recycleBlocked[0].message ?? 'Windows 回收站当前不可用，删除功能已暂停'),
      canDelete: ok.length + longPath.length > 0,
    };
  }

  start(fileIds: number[]): DeleteProgress {
    if (this.isRunning()) throw new Error('删除正在进行，请等待完成或先停止');
    this.stopRequested = false;
    const planned = this.plan(fileIds);
    const failures: DeleteFailure[] = [];
    for (const item of planned) {
      if (item.status === 'ok' || item.status === 'longPath') continue;
      failures.push({
        fileId: item.id,
        path: item.path,
        name: item.name,
        reason: item.message ?? '无法移到回收站',
      });
    }
    const actionable = planned.filter(
      (item) => item.status === 'ok' || item.status === 'longPath',
    );
    const startedAt = this.now();
    this.state = {
      status: 'running',
      total: actionable.length,
      processed: 0,
      succeeded: 0,
      failed: failures.length,
      bytes: 0,
      quarantined: 0,
      currentPath: '',
      startedAt,
      finishedAt: null,
      result: null,
    };
    this.emit();

    this.active = this.run(actionable, failures).finally(() => {
      this.active = null;
    });
    return this.state;
  }

  private async run(
    items: PlannedFile[],
    failures: DeleteFailure[],
  ): Promise<void> {
    const succeededRows: PlannedFile[] = [];
    const quarantinedRows: PlannedFile[] = [];
    let processed = 0;
    let index = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopRequested) return;
        const current = index;
        index += 1;
        if (current >= items.length) return;
        const item = items[current];
        this.state = { ...this.state, currentPath: item.path };
        try {
          if (item.status === 'longPath') {
            if (!this.longTrash) throw new Error('长路径回收区不可用');
            await this.longTrash.quarantine(item.path, { size: item.size, name: item.name });
            quarantinedRows.push(item);
          } else {
            await this.trashItem(item.path);
          }
          succeededRows.push(item);
          this.state = {
            ...this.state,
            succeeded: succeededRows.length,
            bytes: this.state.bytes + item.size,
            quarantined: quarantinedRows.length,
          };
        } catch (error) {
          failures.push({
            fileId: item.id,
            path: item.path,
            name: item.name,
            reason: describeTrashError(error),
          });
          this.state = { ...this.state, failed: failures.length };
        }
        processed += 1;
        this.state = { ...this.state, processed };
        this.emit();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, Math.max(1, items.length)) }, () =>
        worker(),
      ),
    );

    if (succeededRows.length > 0) {
      const scanId = getActiveScanId(this.db);
      const run = getLatestDuplicateRun(this.db);
      try {
        if (scanId !== null) {
          applyDeletedFileRows(
            this.db,
            scanId,
            run && run.status === 'completed' ? run.id : null,
            succeededRows,
          );
        }
      } catch (error) {
        failures.push({
          fileId: 0,
          path: '',
          name: '',
          reason: `文件已移出原位置，但更新索引失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const result: DeleteResult = {
      succeeded: succeededRows.length,
      failed: failures.length,
      bytes: succeededRows.reduce((sum, item) => sum + item.size, 0),
      quarantined: quarantinedRows.length,
      quarantineBytes: quarantinedRows.reduce((sum, item) => sum + item.size, 0),
      failures,
      stopped: this.stopRequested,
    };
    this.state = {
      ...this.state,
      status: 'completed',
      processed: items.length,
      succeeded: result.succeeded,
      failed: result.failed,
      bytes: result.bytes,
      quarantined: result.quarantined,
      currentPath: '',
      finishedAt: this.now(),
      result,
    };
    this.emitEvent?.({ type: 'settled', state: this.state, result });
  }

  private emit(): void {
    this.emitEvent?.({ type: 'state', state: this.state });
  }
}
