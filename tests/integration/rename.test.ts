import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import {
  createRenameRule,
  type RenameItem,
  type RenameRule,
} from '@shared/rename';
import { openDatabase } from '../../src/main/db/connection';
import { createScan, setActiveScanId } from '../../src/main/db/scansRepo';
import { getFileById } from '../../src/main/db/filesRepo';
import { getRootDir, normalizePathKey } from '../../src/main/services/filesystem';
import { RenameService } from '../../src/main/services/renameService';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function rule<T extends RenameRule['type']>(
  type: T,
  patch: Partial<Extract<RenameRule, { type: T }>> = {},
): Extract<RenameRule, { type: T }> {
  return { ...createRenameRule(type), ...patch } as Extract<RenameRule, { type: T }>;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-rename-test-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(path.join(root, 'index.db'));
  cleanups.push(() => db.close());
  const drive = root.slice(0, 2).toUpperCase();
  const scanId = createScan(db, [drive], Date.now());
  setActiveScanId(db, scanId);
  let busy = false;
  const service = new RenameService({
    db,
    fixedDrives: () => new Set([drive]),
    protectedPaths: [],
    isBusy: () => busy,
  });

  function addFile(name: string, content = 'content'): { file: string; id: number } {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const stat = fs.statSync(file, { bigint: true });
    const base = path.basename(file);
    const dir = path.dirname(file);
    const result = db
      .prepare(
        `INSERT INTO files (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scanId,
        drive,
        file,
        normalizePathKey(file),
        base,
        base.toLowerCase(),
        getExtension(base),
        classifyFileName(base),
        Number(stat.size),
        Number(stat.mtimeMs),
        Number(stat.ctimeMs),
        getRootDir(file, `${drive}\\`),
        dir,
        normalizePathKey(dir),
        stat.dev.toString(16),
        stat.ino.toString(16),
      );
    return { file, id: Number(result.lastInsertRowid) };
  }

  function addFolder(name: string): string {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  function item(file: string, id: number | null = null, kind: 'file' | 'folder' = 'file'): RenameItem {
    return { fileId: id, path: file, kind };
  }

  async function run(items: RenameItem[], rules: RenameRule[], afterPreview?: () => void) {
    const preview = await service.preview({ items, rules });
    afterPreview?.();
    const start = service.start(preview.token);
    expect(start.status).toBe('running');
    await service.whenIdle();
    return { preview, final: service.getState() };
  }

  return {
    root,
    db,
    scanId,
    service,
    addFile,
    addFolder,
    item,
    run,
    setBusy(value: boolean) {
      busy = value;
    },
  };
}

describe('批量重命名服务', () => {
  it('预览区分可重命名、重复、跳过、阻止和名称不变，并且不改动磁盘', async () => {
    const fx = setup();
    const photo = fx.addFile('photo.jpg');
    const conflict = fx.addFile('conflict.txt');
    const empty = fx.addFile('empty');
    const folder = fx.addFolder('photos');
    const inner = fx.addFile(path.join('photos', 'inner.txt'));
    fs.writeFileSync(path.join(fx.root, 'conflict-new.txt'), 'occupied');

    const preview = await fx.service.preview({
      items: [
        fx.item(photo.file, photo.id),
        fx.item(photo.file, photo.id),
        fx.item(conflict.file, conflict.id),
        fx.item(empty.file, empty.id),
        fx.item(folder, null, 'folder'),
        fx.item(inner.file, inner.id),
      ],
      rules: [rule('prefixSuffix', { suffix: '-new' })],
    });

    expect(preview.readyCount).toBe(3);
    expect(preview.skippedCount).toBe(2);
    expect(preview.blockedCount).toBe(1);
    expect(preview.unchangedCount).toBe(0);
    const byName = new Map(preview.items.map((entry) => [entry.name, entry]));
    expect(preview.items[0].status).toBe('ready');
    expect(preview.items[0].newName).toBe('photo-new.jpg');
    expect(byName.get('conflict.txt')?.status).toBe('blocked');
    expect(byName.get('conflict.txt')?.message).toContain('目标名称已存在');
    expect(byName.get('empty')?.status).toBe('ready');
    expect(byName.get('empty')?.newName).toBe('empty-new');
    expect(byName.get('photos')?.status).toBe('ready');
    expect(preview.items[1].status).toBe('skipped');
    expect(preview.items[1].message).toContain('重复');
    expect(preview.items[5].status).toBe('skipped');
    expect(preview.items[5].message).toContain('所属文件夹');
    expect(fs.existsSync(photo.file)).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'photo-new.jpg'))).toBe(false);

    const blocked = await fx.service.preview({
      items: [fx.item(empty.file, empty.id)],
      rules: [rule('deleteRange', { start: 1, count: 99 })],
    });
    expect(blocked.items[0].status).toBe('blocked');
    expect(blocked.items[0].message).toBe('新名称为空');

    const unchanged = await fx.service.preview({
      items: [fx.item(photo.file, photo.id)],
      rules: [],
    });
    expect(unchanged.items[0].status).toBe('unchanged');
    expect(unchanged.readyCount).toBe(0);
  });

  it('执行时不覆盖已有目标，并同步文件和文件夹后代的索引', async () => {
    const fx = setup();
    const a = fx.addFile('a.txt', 'alpha');
    const b = fx.addFile('b.txt', 'bravo');
    const folder = fx.addFolder('nested');
    const child = fx.addFile(path.join('nested', 'child.txt'), 'child');
    fx.db
      .prepare(
        "INSERT INTO duplicate_runs (scan_id, status, min_size, created_at, mode) VALUES (?, 'completed', 0, ?, 'full')",
      )
      .run(fx.scanId, Date.now());

    const { preview, final } = await fx.run(
      [
        fx.item(a.file, a.id),
        fx.item(b.file, b.id),
        fx.item(folder, null, 'folder'),
      ],
      [rule('prefixSuffix', { prefix: 'R-' })],
      () => fs.writeFileSync(path.join(fx.root, 'R-b.txt'), 'keep'),
    );

    expect(preview.readyCount).toBe(3);
    expect(final.status).toBe('completed');
    const results = new Map(final.results.map((entry) => [path.basename(entry.source), entry]));
    expect(results.get('a.txt')?.status).toBe('renamed');
    expect(results.get('b.txt')?.status).toBe('failed');
    expect(results.get('b.txt')?.message).toContain('目标名称已存在');
    expect(fs.readFileSync(path.join(fx.root, 'R-a.txt'), 'utf8')).toBe('alpha');
    expect(fs.existsSync(b.file)).toBe(true);
    expect(fs.readFileSync(path.join(fx.root, 'R-b.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(b.file)).toBe(true);
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'R-nested', 'child.txt'))).toBe(true);
    expect(getFileById(fx.db, fx.scanId, a.id)?.path).toBe(path.join(fx.root, 'R-a.txt'));
    expect(getFileById(fx.db, fx.scanId, child.id)?.path).toBe(
      path.join(fx.root, 'R-nested', 'child.txt'),
    );
    const run = fx.db
      .prepare('SELECT status FROM duplicate_runs WHERE scan_id = ?')
      .get(fx.scanId) as { status: string };
    expect(run.status).toBe('stale');
  });

  it('可撤销上次整批操作，并跳过原名称已被占用的项目', async () => {
    const fx = setup();
    const a = fx.addFile('a.txt');
    const b = fx.addFile('b.txt');

    await fx.run(
      [fx.item(a.file, a.id), fx.item(b.file, b.id)],
      [rule('prefixSuffix', { prefix: 'U-' })],
    );
    expect(fx.service.getUndoInfo()).toEqual(expect.objectContaining({ count: 2 }));
    expect(fs.existsSync(path.join(fx.root, 'U-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'U-b.txt'))).toBe(true);

    fs.writeFileSync(a.file, 'occupied');
    const undoState = fx.service.undo();
    expect(undoState.status).toBe('running');
    await fx.service.whenIdle();
    const final = fx.service.getState();
    expect(final.status).toBe('completed');
    const results = new Map(final.results.map((entry) => [path.basename(entry.source), entry]));
    expect(results.get('U-b.txt')?.status).toBe('restored');
    expect(results.get('U-a.txt')?.status).toBe('failed');
    expect(results.get('U-a.txt')?.message).toContain('原名称已被其他文件占用');
    expect(fs.readFileSync(path.join(fx.root, 'U-a.txt'), 'utf8')).toBe('content');
    expect(fs.readFileSync(a.file, 'utf8')).toBe('occupied');
    expect(fs.existsSync(b.file)).toBe(true);
    expect(getFileById(fx.db, fx.scanId, b.id)?.path).toBe(b.file);
    expect(fx.service.getUndoInfo()).toEqual(expect.objectContaining({ count: 1 }));
  });

  it('新一批全部失败时保留上一批的可撤销记录', async () => {
    const fx = setup();
    const a = fx.addFile('a.txt');
    await fx.run([fx.item(a.file, a.id)], [rule('prefixSuffix', { prefix: 'K-' })]);
    expect(fx.service.getUndoInfo()).toEqual(expect.objectContaining({ count: 1 }));

    const b = fx.addFile('b.txt');
    const preview = await fx.service.preview({
      items: [fx.item(b.file, b.id)],
      rules: [rule('prefixSuffix', { prefix: 'Z-' })],
    });
    fs.writeFileSync(path.join(fx.root, 'Z-b.txt'), 'keep');
    fx.service.start(preview.token);
    await fx.service.whenIdle();

    expect(fx.service.getState().results[0].status).toBe('failed');
    expect(fx.service.getUndoInfo()).toEqual(expect.objectContaining({ count: 1 }));
  });

  it('忙碌时拒绝预览，取消后停止并保留已完成项目', async () => {
    const fx = setup();
    fx.setBusy(true);
    await expect(
      fx.service.preview({ items: [fx.item(path.join(fx.root, 'x.txt'))], rules: [] }),
    ).rejects.toThrow(/请等待/);
    fx.setBusy(false);

    const items: RenameItem[] = [];
    const rules = [rule('numbering', { position: 'suffix', separator: '_', padding: 4 })];
    for (let index = 0; index < 60; index += 1) {
      const file = fx.addFile(`file-${index}.txt`);
      items.push(fx.item(file.file, file.id));
    }
    const preview = await fx.service.preview({ items, rules });
    expect(preview.readyCount).toBe(60);
    fx.service.start(preview.token);
    fx.service.cancel();
    await fx.service.whenIdle();
    const final = fx.service.getState();
    expect(final.status).toBe('cancelled');
    expect(final.results.length).toBe(final.processed);
    const onDisk = fs.readdirSync(fx.root).filter((name) => name.startsWith('file-'));
    expect(onDisk.length).toBe(60);
  });

  it('刷新预览后目标被占用时开始任务不会覆盖', async () => {
    const fx = setup();
    const file = fx.addFile('preview.txt');
    const preview = await fx.service.preview({
      items: [fx.item(file.file, file.id)],
      rules: [rule('prefixSuffix', { prefix: 'P-' })],
    });
    expect(preview.readyCount).toBe(1);
    fs.writeFileSync(path.join(fx.root, 'P-preview.txt'), 'keep');
    fx.service.start(preview.token);
    await fx.service.whenIdle();
    const final = fx.service.getState();
    expect(final.results[0].status).toBe('failed');
    expect(fs.readFileSync(path.join(fx.root, 'P-preview.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(file.file)).toBe(true);
  });
});
