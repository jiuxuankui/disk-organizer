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
  namePatternMode: 'exact',
  targetDir,
  minSize: null,
  maxSize: null,
  mtimeFrom: null,
  mtimeTo: null,
  pathContains: '',
  matchMode: 'all',
});
const makeFolderRule = (targetDir: string, patch: Partial<OrganizeRule> = {}): OrganizeRule => ({
  ...makeRule(targetDir),
  name: '文件夹归档',
  type: 'folder',
  ...patch,
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organize-test-'));
  const cross = fs.mkdtempSync(path.join(process.cwd(), '.tmp-organize-cross-'));
  cleanups.push(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cross, { recursive: true, force: true });
  });
  const sourceDir = path.join(root, 'source');
  const source2 = path.join(root, 'source2');
  const output = path.join(root, 'output');
  const trash = path.join(root, 'recoverable');
  for (const dir of [sourceDir, source2, output, trash]) fs.mkdirSync(dir);
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
      let destination = path.join(trash, path.basename(file));
      for (let suffix = 1; fs.existsSync(destination); suffix += 1) {
        destination = path.join(trash, `${path.basename(file)} (${suffix})`);
      }
      moveFileNoReplace(file, destination);
    },
    longTrash: {
      needsQuarantine: () => false,
      quarantine: async () => {
        throw new Error('unexpected long path');
      },
    },
  };
  const job = new OrganizeService(deps);
  function insert(name: string, content: string | Buffer = 'original content', target = sourceDir) {
    const file = path.join(target, name);
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
    return job.plan({ sourceDirs: [sourceDir], rules: [makeRule(targetDir)], priority: 'order' });
  }
  function planSmart(targetRoot = output, categories: SmartCategory[] = SMART_CATEGORY_LIST) {
    return job.planSmart({ sourceDirs: [sourceDir], targetRoot, categories });
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
    source2,
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
  it('合并多个来源文件夹，重复或嵌套的来源只扫描一次', async () => {
    const s = setup();
    const first = s.insert('first.txt');
    const second = s.insert('second.txt', 'second content', s.source2);
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir, s.source2],
      rules: [makeRule(s.output)],
      priority: 'order',
    });
    expect(preview.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );
    expect(preview.items.every((item) => item.allowed)).toBe(true);

    const nested = await s.job.plan({
      sourceDirs: [s.root, s.sourceDir, s.source2],
      rules: [makeRule(s.output)],
      priority: 'order',
    });
    expect(nested.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );
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
  it('包含匹配只归档名字中任意位置出现该格式的文件', async () => {
    const s = setup();
    const hit = s.insert('会议 AB-123 备份.txt');
    s.insert('AB-12.txt');
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [{ ...makeRule(s.output), namePattern: 'XX-XXX', namePatternMode: 'contains' }],
      priority: 'order',
    });
    expect(preview.items.map((item) => item.id)).toEqual([hit.id]);
    expect(preview.items[0].allowed).toBe(true);
  });
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
      sourceDirs: [s.sourceDir],
      rules: [{ ...makeRule(s.output), type: 'video' }],
      priority: 'order',
    });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ id: hit.id, allowed: true });
  }, 30000);

  it('自定义规则的命中数超过 50000 时拒绝预览', async () => {
    const s = setup();
    s.insertSynthetic(50001, 'video');
    await expect(
      s.job.plan({ sourceDirs: [s.sourceDir], rules: [makeRule(s.output)], priority: 'order' }),
    ).rejects.toThrow('命中规则的文件超过 50000 个，请缩小来源或规则范围');
  }, 120000);

  it('一键智能归类同样按命中数限制', async () => {
    const s = setup();
    s.insertSynthetic(50001, 'video');
    await expect(
      s.job.planSmart({
        sourceDirs: [s.sourceDir],
        targetRoot: s.output,
        categories: ['video'],
      }),
    ).rejects.toThrow('命中规则的文件超过 50000 个，请缩小来源或规则范围');
  }, 120000);

  it('一键智能归类合并多个来源文件夹', async () => {
    const s = setup();
    const movie = s.insert('movie.mp4', 'video bytes');
    const pic = s.insert('pic.png', 'image bytes', s.source2);
    const preview = await s.job.planSmart({
      sourceDirs: [s.sourceDir, s.source2],
      targetRoot: s.output,
      categories: ['video', 'image'],
    });
    expect(preview.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
      [movie.id, pic.id].sort((a, b) => a - b),
    );
    expect(preview.items.every((item) => item.allowed)).toBe(true);
  });
});

describe('manual move and empty folder cleanup', () => {
  it('moves selected files and folders to the target and recycles emptied source folders', async () => {
    const s = setup();
    const loose = s.insert('loose.txt', 'loose');
    const album = s.insert(path.join('album', 'a.txt'), 'album payload');
    const preview = await s.job.planMove({
      fileIds: [loose.id],
      folderPaths: [path.join(s.sourceDir, 'album')],
      targetDir: s.output,
    });
    expect(preview).toMatchObject({
      movableCount: 2,
      blockedCount: 0,
      fileCount: 1,
      folderCount: 1,
    });
    expect(preview.items.find((item) => item.kind === 'folder')?.rule).toBe('手动移动');
    s.job.startMove({ token: preview.token, confirmCrossDrive: false });
    await s.job.whenIdle();
    const state = s.job.getState();
    expect(state.status).toBe('completed');
    expect(state.results.map((item) => item.status)).toEqual(['moved', 'moved']);
    expect(fs.readFileSync(path.join(s.output, 'loose.txt'), 'utf8')).toBe('loose');
    expect(fs.readFileSync(path.join(s.output, 'album', 'a.txt'), 'utf8')).toBe('album payload');
    expect(fs.existsSync(s.sourceDir)).toBe(false);
    expect(fs.existsSync(path.join(s.trash, 'source'))).toBe(true);
    expect(state.cleanup).toMatchObject({ cleaned: 1, failed: [] });
    expect(getFileById(s.db, s.scanId, loose.id)?.path).toBe(path.join(s.output, 'loose.txt'));
    expect(getFileById(s.db, s.scanId, album.id)?.path).toBe(
      path.join(s.output, 'album', 'a.txt'),
    );
  });

  it('cleans the emptied parent chain upward but keeps unrelated empty folders', async () => {
    const s = setup();
    const keep = s.insert('keep.txt', 'keep');
    const a = s.insert(path.join('nest', 'a', 'x.txt'), 'x');
    const b = s.insert(path.join('nest', 'b', 'y.txt'), 'y');
    fs.mkdirSync(path.join(s.sourceDir, 'already-empty'));
    const preview = await s.job.planMove({
      fileIds: [a.id, b.id],
      folderPaths: [],
      targetDir: s.output,
    });
    expect(preview.items.every((item) => item.allowed)).toBe(true);
    s.job.startMove({ token: preview.token, confirmCrossDrive: false });
    await s.job.whenIdle();
    const state = s.job.getState();
    expect(state.cleanup?.cleaned).toBe(3);
    expect(fs.existsSync(path.join(s.sourceDir, 'nest'))).toBe(false);
    expect(fs.existsSync(path.join(s.trash, 'nest'))).toBe(true);
    expect(fs.existsSync(path.join(s.sourceDir, 'already-empty'))).toBe(true);
    expect(fs.existsSync(keep.file)).toBe(true);
  });

  it('keeps a folder that still has content or cannot be recycled, and reports the failure', async () => {
    const s = setup();
    const kept = s.insert(path.join('shared', 'kept.txt'), 'kept');
    const moved = s.insert(path.join('shared', 'moved.txt'), 'moved');
    const solo = s.insert(path.join('solo', 'solo.txt'), 'solo');
    s.deps.trashItem = async (target) => {
      if (fs.statSync(target).isDirectory()) throw new Error('recycle folder failed');
      moveFileNoReplace(target, path.join(s.trash, path.basename(target)));
    };
    const preview = await s.job.planMove({
      fileIds: [moved.id, solo.id],
      folderPaths: [],
      targetDir: s.output,
    });
    s.job.startMove({ token: preview.token, confirmCrossDrive: false });
    await s.job.whenIdle();
    const state = s.job.getState();
    expect(state.results.map((item) => item.status)).toEqual(['moved', 'moved']);
    expect(fs.existsSync(path.join(s.sourceDir, 'shared'))).toBe(true);
    expect(fs.readdirSync(path.join(s.sourceDir, 'shared'))).toEqual(['kept.txt']);
    expect(fs.existsSync(kept.file)).toBe(true);
    expect(state.cleanup).toMatchObject({ cleaned: 0 });
    expect(state.cleanup?.failed).toEqual([
      {
        path: path.join(s.sourceDir, 'solo'),
        reason: expect.stringContaining('放入回收站失败'),
      },
    ]);
    expect(fs.readdirSync(path.join(s.sourceDir, 'solo'))).toEqual([]);
  });

  it('drops files covered by selected folders and blocks targets inside the selection', async () => {
    const s = setup();
    const inner = s.insert(path.join('album', 'inner.txt'), 'inner');
    s.insert(path.join('album', 'sub', 'deep.txt'), 'deep');
    const albumPath = path.join(s.sourceDir, 'album');
    const preview = await s.job.planMove({
      fileIds: [inner.id],
      folderPaths: [albumPath, path.join(albumPath, 'sub')],
      targetDir: s.output,
    });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ kind: 'folder', source: albumPath, allowed: true });

    const inside = path.join(albumPath, 'dest');
    fs.mkdirSync(inside);
    const blocked = await s.job.planMove({
      fileIds: [],
      folderPaths: [albumPath],
      targetDir: inside,
    });
    expect(blocked.items[0].allowed).toBe(false);
    expect(blocked.items[0].message).toBe('目标文件夹不能位于来源文件夹内部');

    const same = await s.job.planMove({
      fileIds: [inner.id],
      folderPaths: [],
      targetDir: albumPath,
    });
    expect(same.items[0].allowed).toBe(false);
    expect(same.items[0].message).toBe('已在目标文件夹，无需移动');
  });

  it('requires confirmation for cross-drive files and rejects cross-drive folders', async () => {
    const s = setup();
    const file = s.insert('cross.txt', randomBytes(64));
    s.insert(path.join('album', 'a.txt'), 'a');
    const preview = await s.job.planMove({
      fileIds: [file.id],
      folderPaths: [path.join(s.sourceDir, 'album')],
      targetDir: s.cross,
    });
    const fileItem = preview.items.find((item) => item.kind === 'file');
    const folderItem = preview.items.find((item) => item.kind === 'folder');
    expect(fileItem).toMatchObject({ allowed: true, crossDrive: true });
    expect(folderItem).toMatchObject({ allowed: false, crossDrive: true });
    expect(folderItem?.message).toContain('文件夹不支持跨盘移动');
    expect(() =>
      s.job.startMove({ token: preview.token, confirmCrossDrive: false }),
    ).toThrow('必须明确确认');
    s.job.startMove({ token: preview.token, confirmCrossDrive: true });
    await s.job.whenIdle();
    const state = s.job.getState();
    expect(state.results.map((item) => item.status)).toEqual(['moved']);
    expect(fs.existsSync(path.join(s.cross, 'cross.txt'))).toBe(true);
    expect(fs.existsSync(file.file)).toBe(false);
    expect(fs.existsSync(path.join(s.sourceDir, 'album', 'a.txt'))).toBe(true);
    expect(state.cleanup).toMatchObject({ cleaned: 0, failed: [] });
  });
});

describe('organize cleanup of emptied source folders', () => {
  it('recycles folders emptied by custom rule moves', async () => {
    const s = setup();
    const keep = s.insert('keep.txt', 'keep');
    const movie = s.insert(path.join('bucket', 'movie.mp4'), 'video');
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [{ ...makeRule(s.output), type: 'video' }],
      priority: 'order',
    });
    s.job.start({ token: preview.token, fileIds: [movie.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().cleanup?.cleaned).toBe(1);
    expect(fs.existsSync(path.join(s.sourceDir, 'bucket'))).toBe(false);
    expect(fs.existsSync(path.join(s.trash, 'bucket'))).toBe(true);
    expect(fs.existsSync(keep.file)).toBe(true);
  });

  it('recycles folders emptied by smart organize moves', async () => {
    const s = setup();
    s.insert('keep.txt', 'keep');
    const movie = s.insert(path.join('media', 'movie.mp4'), 'video');
    const preview = await s.planSmart(s.output, ['video']);
    s.job.start({ token: preview.token, fileIds: [movie.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().cleanup?.cleaned).toBe(1);
    expect(fs.existsSync(path.join(s.sourceDir, 'media'))).toBe(false);
    expect(fs.existsSync(path.join(s.trash, 'media'))).toBe(true);
  });
});

describe('folder organization', () => {
  it('moves an entire folder and updates the index of every file inside', async () => {
    const s = setup();
    const image = s.insert(path.join('album-2024', 'a.jpg'), 'image');
    const deep = s.insert(path.join('album-2024', 'sub', 'b.txt'), 'deep');
    const loose = s.insert('loose.txt', 'loose');
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.output, { nameContains: 'album' })],
      priority: 'order',
    });
    expect(preview.items).toHaveLength(1);
    const folder = preview.items[0];
    expect(folder).toMatchObject({ kind: 'folder', allowed: true, crossDrive: false });
    expect(folder.id).toBeLessThan(0);
    expect(folder.target).toBe(path.join(s.output, 'album-2024'));

    s.job.start({ token: preview.token, fileIds: [folder.id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(s.job.getState().results.map((item) => item.status)).toEqual(['moved']);
    expect(s.job.getState().results[0].message).toContain('文件夹移动完成');
    expect(fs.existsSync(path.join(s.output, 'album-2024', 'a.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(s.output, 'album-2024', 'sub', 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(s.sourceDir, 'album-2024'))).toBe(false);
    expect(fs.existsSync(loose.file)).toBe(true);
    expect(getFileById(s.db, s.scanId, image.id)?.path).toBe(
      path.join(s.output, 'album-2024', 'a.jpg'),
    );
    expect(getFileById(s.db, s.scanId, deep.id)?.path).toBe(
      path.join(s.output, 'album-2024', 'sub', 'b.txt'),
    );
    expect(getFileById(s.db, s.scanId, deep.id)?.dirPath).toBe(
      path.join(s.output, 'album-2024', 'sub'),
    );
  });

  it('lists only the outermost matching folder and hides files it already covers', async () => {
    const s = setup();
    s.insert(path.join('album', 'top.txt'), 'top');
    s.insert(path.join('album', 'inner', 'deep.txt'), 'deep');
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeRule(s.output), makeFolderRule(s.output, { pathContains: 'album' })],
      priority: 'order',
    });
    expect(preview.items.filter((item) => item.kind === 'folder')).toHaveLength(1);
    expect(preview.items[0].source).toBe(path.join(s.sourceDir, 'album'));
    expect(preview.items.some((item) => item.kind === 'file')).toBe(false);
  });

  it('numbers a colliding folder target and never overwrites existing content', async () => {
    const s = setup();
    s.insert(path.join('album', 'new.txt'), 'new');
    fs.mkdirSync(path.join(s.output, 'album'));
    fs.writeFileSync(path.join(s.output, 'album', 'keep.txt'), 'old');
    const preview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.output, { nameContains: 'album' })],
      priority: 'order',
    });
    expect(preview.items[0].target).toBe(path.join(s.output, 'album (1)'));
    s.job.start({ token: preview.token, fileIds: [preview.items[0].id], confirmCrossDrive: false });
    await s.job.whenIdle();
    expect(fs.readFileSync(path.join(s.output, 'album', 'keep.txt'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(s.output, 'album (1)', 'new.txt'), 'utf8')).toBe('new');
  });

  it('blocks cross-drive folders, targets inside the folder and the same location', async () => {
    const s = setup();
    s.insert(path.join('album', 'a.txt'), 'a');

    const crossPreview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.cross, { nameContains: 'album' })],
      priority: 'order',
    });
    expect(crossPreview.items[0]).toMatchObject({
      kind: 'folder',
      crossDrive: true,
      allowed: false,
    });
    expect(crossPreview.items[0].message).toContain('文件夹不支持跨盘整理');
    expect(() =>
      s.job.start({
        token: crossPreview.token,
        fileIds: [crossPreview.items[0].id],
        confirmCrossDrive: true,
      }),
    ).toThrow('不可移动');

    const inside = path.join(s.sourceDir, 'album', 'dest');
    fs.mkdirSync(inside);
    const insidePreview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(inside, { nameContains: 'album' })],
      priority: 'order',
    });
    expect(insidePreview.items[0].allowed).toBe(false);
    expect(insidePreview.items[0].message).toBe('目标文件夹不能位于来源文件夹内部');

    const samePreview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.sourceDir, { nameContains: 'album' })],
      priority: 'order',
    });
    expect(samePreview.items[0].allowed).toBe(false);
    expect(samePreview.items[0].message).toBe('已在目标文件夹，无需移动');
  });

  it('rejects system folders and linked folders', async () => {
    const s = setup();
    s.insert(path.join('system-flag', 'x.txt'), 'x');
    execFileSync('attrib', ['+s', path.join(s.sourceDir, 'system-flag')]);
    const systemPreview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.output, { nameContains: 'system-flag' })],
      priority: 'order',
    });
    expect(systemPreview.items[0].allowed).toBe(false);
    expect(systemPreview.items[0].message).toBe('不能整理系统文件夹');

    const real = path.join(s.sourceDir, 'real-target');
    fs.mkdirSync(real);
    const link = path.join(s.sourceDir, 'linked');
    fs.symlinkSync(real, link, 'junction');
    s.insert(path.join('linked', 'y.txt'), 'y');
    const linkPreview = await s.job.plan({
      sourceDirs: [s.sourceDir],
      rules: [makeFolderRule(s.output, { nameContains: 'linked' })],
      priority: 'order',
    });
    expect(linkPreview.items[0].allowed).toBe(false);
    expect(linkPreview.items[0].message).toContain('链接或重定向');
  });
});
