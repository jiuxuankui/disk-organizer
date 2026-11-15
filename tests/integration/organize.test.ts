import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFileName, getExtension } from '@shared/fileTypes';
import type { FileTypeKey } from '@shared/types';
import type { OrganizeRule, SmartCategory } from '@shared/organize';
import { openDatabase } from '../../src/main/db/connection';
import { createScan, finalizeScan, setActiveScanId } from '../../src/main/db/scansRepo';
import { getFileById } from '../../src/main/db/filesRepo';
import { normalizePathKey, getRootDir } from '../../src/main/services/filesystem';
import { OrganizeService } from '../../src/main/services/organizeService';
import { copyVerifiedForMove, organizeLocalPath } from '../../src/main/services/organizeCore';
import { SettingsService } from '../../src/main/services/settingsService';
import { createFakeRecyclePolicy } from '../../src/main/devOverrides';
import { moveFileNoReplace } from '../../src/main/services/windowsService';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const digest = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const makeRule = (targetDir: string): OrganizeRule => ({
  id: randomUUID(),
  name: '集中归档',
  enabled: true,
  type: 'all',
  extensions: [],
  nameContains: '',
  namePattern: '',
  targetDir,
  minSize: null,
  maxSize: null,
  mtimeFrom: null,
  mtimeTo: null,
  pathContains: '',
  matchMode: 'all',
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organize-test-'));
  const cross = fs.mkdtempSync(path.join(process.cwd(), '.tmp-organize-cross-'));
  cleanups.push(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cross, { recursive: true, force: true });
  });
  const sourceDir = path.join(root, 'source');
  const output = path.join(root, 'output');
  const trash = path.join(root, 'recoverable');
  for (const dir of [sourceDir, output, trash]) fs.mkdirSync(dir);
  const db = openDatabase(path.join(root, 'index.db'));
  cleanups.push(() => db.close());
  const drive = root.slice(0, 2).toUpperCase();
  const scanId = createScan(db, [drive], Date.now());
  setActiveScanId(db, scanId);
  const policy = createFakeRecyclePolicy();
  const deps = {
    db,
    fixedDrives: () => new Set([drive, cross.slice(0, 2).toUpperCase()]),
    protectedPaths: [] as string[],
    getRecyclePolicy: () => policy,
    trashItem: async (file: string) => {
      moveFileNoReplace(file, path.join(trash, path.basename(file)));
    },
    longTrash: {
      needsQuarantine: () => false,
      quarantine: async () => {
        throw new Error('unexpected long path');
      },
    },
  };
  const job = new OrganizeService(deps);
  function insert(name: string, content: string | Buffer = 'original content') {
    const file = path.join(sourceDir, name);
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
    const totals = db.prepare('SELECT COUNT(*) AS count, SUM(size) AS bytes FROM files').get() as {
      count: number;
      bytes: number;
    };
    finalizeScan(db, scanId, {
      totalFiles: totals.count,
      identifiedBytes: totals.bytes,
      skipped: [],
      finishedAt: Date.now(),
    });
    return { file, id: Number(result.lastInsertRowid), hash: digest(file) };
  }
  function plan(targetDir = output) {
    return job.plan({ sourceDir, rules: [makeRule(targetDir)], priority: 'order' });
  }
  function planSmart(targetRoot = output, categories: SmartCategory[] = SMART_CATEGORY_LIST) {
    return job.planSmart({ sourceDir, targetRoot, categories });
  }
  function insertSynthetic(count: number, type: FileTypeKey, stem = 'bulk') {
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const statement = db.prepare(
      `INSERT INTO files (scan_id, drive, path, path_key, name, name_key, ext, type, size, mtime_ms, ctime_ms, root_dir, dir_path, dir_key, volume_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
    );
    db.exec('BEGIN');
    try {
      for (let index = 0; index < count; index += 1) {
        const file = path.join(sourceDir, `${stem}-${index}.${ext}`);
        const name = path.basename(file);
        const dir = path.dirname(file);
        statement.run(
          scanId,
          drive,
          file,
          normalizePathKey(file),
          name,
          name.toLowerCase(),
          ext,
          type,
          1,
          1,
          1,
          getRootDir(file, `${drive}\\`),
          dir,
          normalizePathKey(dir),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const totals = db.prepare('SELECT COUNT(*) AS count, SUM(size) AS bytes FROM files').get() as {
      count: number;
      bytes: number;
    };
    finalizeScan(db, scanId, {
      totalFiles: totals.count,
      identifiedBytes: totals.bytes,
      skipped: [],
      finishedAt: Date.now(),
    });
  }
  return {
    root,
    cross,
    sourceDir,
    output,
    trash,
    db,
    scanId,
    drive,
    deps,
    job,
    insert,
    insertSynthetic,
    plan,
    planSmart,
  };
}

const SMART_CATEGORY_LIST: SmartCategory[] = [
  'video',
  'image',
  'document',
  'audio',
  'archive',
  'installer',
  'other',
];

describe('safe file organization', () => {
  it('moves real same-drive files, numbers collisions and updates paths/identity', async () => {
    const s = setup();
    const a = s.insert('a/同名.txt', 'first');
    const b = s.insert('b/同名.txt', 'second');
    fs.writeFileSync(path.join(s.output, '同名.txt'), 'existing');
    const preview = await s.plan();
    expect(preview.items.map((item) => item.allowed)).toEqual([true, true]);
    expect(preview.items.every((item) => !item.crossDrive)).toBe(true);
    expect(preview.items.map((item) => path.basename(item.target))).toEqual([
      '同名 (1).txt',
      '同名 (2).txt',
    ]);
    s.job.start({ token: preview.token, fileIds: [a.id, b.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().results.map((item) => item.status)).toEqual(['moved', 'moved']);
    [a, b].forEach((file, index) => {
      const target = preview.items[index].target;
      expect(fs.existsSync(file.file)).toBe(false);
      expect(digest(target)).toBe(file.hash);
      expect(getFileById(s.db, s.scanId, file.id)?.path).toBe(target);
    });
    expect(fs.readFileSync(path.join(s.output, '同名.txt'), 'utf8')).toBe('existing');
    expect(s.db.prepare('SELECT total_files, identified_bytes FROM scans').get()).toEqual({
      total_files: 2,
      identified_bytes: 11,
    });
  });
  it('never overwrites a destination created after preview', async () => {
    const s = setup();
    const file = s.insert('collision.txt');
    const preview = await s.plan();
    fs.writeFileSync(preview.items[0].target, 'created externally');
    s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().results[0].status).toBe('failed');
    expect(digest(file.file)).toBe(file.hash);
    expect(fs.readFileSync(preview.items[0].target, 'utf8')).toBe('created externally');
  });
  it('rejects changed sources, obsolete previews and foreign ids without moving files', async () => {
    const s = setup();
    const file = s.insert('changing.txt');
    const preview = await s.plan();
    expect(() =>
      s.job.start({ token: randomUUID(), fileIds: [file.id], confirmCrossDrive: false }),
    ).toThrow('预览已失效');
    expect(() =>
      s.job.start({ token: preview.token, fileIds: [999], confirmCrossDrive: false }),
    ).toThrow('不可移动');
    fs.appendFileSync(file.file, 'external change');
    s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().results[0].message).toContain('已变化');
    expect(fs.readdirSync(s.output)).toEqual([]);
  });
  it('requires confirmation for real cross-volume copy, verifies bytes before recycling and keeps recoverable originals', async () => {
    const s = setup();
    const file = s.insert('cross.txt', randomBytes(1024 * 1024));
    expect(fs.statSync(s.sourceDir).dev).not.toBe(fs.statSync(s.cross).dev);
    const preview = await s.plan(s.cross);
    expect(preview.items[0].crossDrive).toBe(true);
    expect(() =>
      s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: false }),
    ).toThrow('必须明确确认');
    expect(fs.readdirSync(s.cross)).toEqual([]);
    s.deps.trashItem = async (source) => {
      expect(digest(preview.items[0].target)).toBe(file.hash);
      expect(digest(source)).toBe(file.hash);
      moveFileNoReplace(source, path.join(s.trash, 'cross.txt'));
    };
    s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: true });
    await s.job.whenIdle();
    expect(s.job.getState().results[0].status).toBe('moved');
    expect(digest(path.join(s.trash, 'cross.txt'))).toBe(file.hash);
    expect(digest(preview.items[0].target)).toBe(file.hash);
    expect(getFileById(s.db, s.scanId, file.id)?.drive).toBe(s.cross.slice(0, 2).toUpperCase());
    expect(fs.readdirSync(s.cross)).toEqual(['cross.txt']);
  });
  it('blocks unavailable recycling and retains both files if recycling fails', async () => {
    const s = setup();
    const file = s.insert('keep.txt');
    s.deps.getRecyclePolicy().available = false;
    expect((await s.plan(s.cross)).items[0].allowed).toBe(false);
    expect(fs.existsSync(file.file)).toBe(true);
    s.deps.getRecyclePolicy().available = true;
    const preview = await s.plan(s.cross);
    s.deps.trashItem = async () => {
      throw new Error('recycle failed');
    };
    s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: true });
    await s.job.whenIdle();
    expect(s.job.getState().results[0].message).toContain('原件及已生成副本保留');
    expect(digest(file.file)).toBe(file.hash);
    expect(digest(preview.items[0].target)).toBe(file.hash);
    expect(getFileById(s.db, s.scanId, file.id)?.path).toBe(file.file);
  });
  it('cancels an active cross-volume copy, cleans only its temporary files and allows restart', async () => {
    const s = setup();
    const file = s.insert('large.bin', randomBytes(32 * 1024 * 1024));
    const preview = await s.plan(s.cross);
    s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: true });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error('copy did not start'));
      }, 15000);
      const timer = setInterval(() => {
        if (fs.readdirSync(s.cross).some((name) => name.startsWith('.disk-organizer-move-'))) {
          clearTimeout(timeout);
          clearInterval(timer);
          resolve();
        }
      }, 1);
    });
    s.job.cancel();
    await s.job.whenIdle();
    expect(s.job.getState().status).toBe('cancelled');
    expect(digest(file.file)).toBe(file.hash);
    expect(fs.readdirSync(s.cross)).toEqual([]);
    const next = await s.plan();
    s.job.start({ token: next.token, fileIds: [file.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().results[0].status).toBe('moved');
  }, 30000);
  it('rejects sources changed during the copy and preserves unrelated destination content', async () => {
    const s = setup();
    const file = s.insert('changing.bin', randomBytes(32 * 1024 * 1024));
    const target = path.join(s.cross, 'changed.bin');
    fs.writeFileSync(path.join(s.cross, 'untouched.txt'), 'existing');
    const copying = copyVerifiedForMove(file.file, target, new AbortController().signal);
    fs.appendFileSync(file.file, 'changed');
    await expect(copying).rejects.toThrow('已变化');
    expect(fs.readdirSync(s.cross)).toEqual(['untouched.txt']);
    expect(fs.statSync(file.file).size).toBe(32 * 1024 * 1024 + 7);
  }, 30000);
  it('allows system-attribute directories but still rejects system-attribute files', () => {
    const s = setup();
    execFileSync('attrib', ['+s', s.sourceDir]);
    expect(organizeLocalPath(s.sourceDir, s.deps.fixedDrives(), [], 'directory')).toBe(
      fs.realpathSync(s.sourceDir),
    );
    const file = s.insert('system-flagged.txt');
    execFileSync('attrib', ['+s', file.file]);
    expect(() => organizeLocalPath(file.file, s.deps.fixedDrives(), [], 'file')).toThrow(
      '不能整理系统文件',
    );
    expect(organizeLocalPath(file.file, s.deps.fixedDrives(), [], 'directory')).toBe(
      fs.realpathSync(file.file),
    );
  });
  it('blocks redirects/protected paths and persists custom rules without losing old scan settings', () => {
    const s = setup();
    expect(() => organizeLocalPath(s.root, s.deps.fixedDrives(), [s.root])).toThrow('不能参与整理');
    const link = path.join(s.root, 'redirect');
    fs.symlinkSync(s.output, link, 'junction');
    expect(() => organizeLocalPath(link, s.deps.fixedDrives(), [])).toThrow('链接或重定向');
    const settingsFile = path.join(s.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ scanDrives: ['E:'], autoBackup: false }));
    const settings = new SettingsService(settingsFile);
    expect(settings.get().organizeRules).toEqual([]);
    const rules = [makeRule(s.output)];
    settings.update({ organizeRules: rules });
    expect(new SettingsService(settingsFile).get()).toMatchObject({
      scanDrives: ['E:'],
      autoBackup: false,
      organizeRules: rules,
    });
  });
});

describe('smart organize', () => {
  it('分到类型子文件夹，仅在实际移动时创建子目录', async () => {
    const s = setup();
    const video = s.insert('movie.mp4', randomBytes(64));
    const image = s.insert('pic.png', randomBytes(64));
    const doc = s.insert('note.txt', 'text');
    const preview = await s.planSmart();
    expect(preview.items).toHaveLength(3);
    const bySource = new Map(preview.items.map((item) => [item.source, item]));
    expect(bySource.get(video.file)?.target).toBe(path.join(s.output, '视频', 'movie.mp4'));
    expect(bySource.get(image.file)?.target).toBe(path.join(s.output, '图片', 'pic.png'));
    expect(bySource.get(doc.file)?.target).toBe(path.join(s.output, '文档', 'note.txt'));
    expect(fs.readdirSync(s.output)).toEqual([]);
    s.job.start({
      token: preview.token,
      fileIds: preview.items.map((item) => item.id),
      confirmCrossDrive: false,
    });
    await s.job.whenIdle();
    expect(s.job.getState().results.map((item) => item.status)).toEqual([
      'moved',
      'moved',
      'moved',
    ]);
    expect(fs.readdirSync(s.output).sort()).toEqual(['图片', '文档', '视频'].sort());
    expect(fs.existsSync(path.join(s.output, '视频', 'movie.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(s.output, '图片', 'pic.png'))).toBe(true);
    expect(fs.existsSync(path.join(s.output, '文档', 'note.txt'))).toBe(true);
  });

  it('目标根目录已有同名文件时该类别整体不可移动且不改动已有内容', async () => {
    const s = setup();
    s.insert('a.mp4', 'x');
    s.insert('b.mp4', 'y');
    fs.writeFileSync(path.join(s.output, '视频'), 'blocking file');
    const preview = await s.planSmart();
    expect(preview.items).toHaveLength(2);
    expect(preview.items.every((item) => !item.allowed)).toBe(true);
    expect(preview.items.every((item) => item.message.includes('同名文件'))).toBe(true);
    expect(fs.readFileSync(path.join(s.output, '视频'), 'utf8')).toBe('blocking file');
  });

  it('未勾选的类别不出现在预览中', async () => {
    const s = setup();
    s.insert('movie.mp4', 'x');
    s.insert('pic.png', 'y');
    const preview = await s.planSmart(s.output, ['video']);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].rule).toBe('视频');
  });

  it('跨盘智能归类同样需要单独确认', async () => {
    const s = setup();
    const file = s.insert('movie.mp4', randomBytes(1024));
    const preview = await s.planSmart(s.cross, ['video']);
    expect(preview.items[0].crossDrive).toBe(true);
    expect(() =>
      s.job.start({ token: preview.token, fileIds: [file.id], confirmCrossDrive: false }),
    ).toThrow('必须明确确认');
    expect(fs.readdirSync(s.cross)).toEqual([]);
  });
});

describe('organize preview source limits', () => {
  it('预览只按命中数限制：来源下 10001 个不命中文件 + 1 个命中文件仍成功', async () => {
    const s = setup();
    s.insertSynthetic(10001, 'image');
    const hit = s.insert('movie.mp4');
    const preview = await s.job.plan({
      sourceDir: s.sourceDir,
      rules: [{ ...makeRule(s.output), type: 'video' }],
      priority: 'order',
    });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ id: hit.id, allowed: true });
  }, 30000);

  it('自定义规则的命中数超过 10000 时拒绝预览', async () => {
    const s = setup();
    s.insertSynthetic(10001, 'video');
    await expect(
      s.job.plan({ sourceDir: s.sourceDir, rules: [makeRule(s.output)], priority: 'order' }),
    ).rejects.toThrow('命中规则的文件超过 10000 个，请缩小来源或规则范围');
  }, 30000);

  it('一键智能归类同样按命中数限制', async () => {
    const s = setup();
    s.insertSynthetic(10001, 'video');
    await expect(
      s.job.planSmart({ sourceDir: s.sourceDir, targetRoot: s.output, categories: ['video'] }),
    ).rejects.toThrow('命中规则的文件超过 10000 个，请缩小来源或规则范围');
  }, 30000);
});
