import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const project = path.resolve(__dirname, '../..');
let root: string;
let fixture: string;
let output: string;
let app: ElectronApplication;
let page: Page;
const originals = new Map<string, string>();
const errors: string[] = [];
const digest = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const modal = () => page.locator('.ant-modal:visible');

async function select(name: string): Promise<void> {
  await page.locator('.files-search input').fill(name);
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(1);
  await expect(page.locator('.files-panel .ant-table-row')).toContainText(name);
  await page.locator('.files-panel .ant-table-row input[type=checkbox]').check();
}

async function outputDialog(canceled = false): Promise<void> {
  await app.evaluate(
    ({ dialog }, args) => {
      dialog.showOpenDialog = async () => ({ canceled: args.canceled, filePaths: [args.output] });
    },
    { canceled, output },
  );
  await modal().getByRole('button', { name: '选择输出文件夹', exact: true }).click();
}

function verifyArchive(file: string, relativeFiles: string[]): void {
  const extraction = fs.mkdtempSync(path.join(root, 'extracted-'));
  execFileSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
    ['-xf', file, '-C', extraction],
    { windowsHide: true },
  );
  for (const relative of relativeFiles) {
    const source = path.join(fixture, relative);
    const entry = source[0].toUpperCase() + source.slice(2).replaceAll('\\', '/');
    expect(digest(path.join(extraction, entry))).toBe(originals.get(relative));
    expect(digest(source)).toBe(originals.get(relative));
  }
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-archive-e2e-'));
  fixture = path.join(root, 'source');
  output = path.join(root, 'output');
  fs.mkdirSync(fixture);
  fs.mkdirSync(output);
  for (let i = 0; i < 201; i += 1) {
    const name = `pack-${i.toString().padStart(3, '0')}.txt`;
    fs.writeFileSync(path.join(fixture, name), `file ${i}\n`.repeat(1000));
    originals.set(name, digest(path.join(fixture, name)));
  }
  fs.writeFileSync(path.join(fixture, 'cancel.bin'), randomBytes(32 * 1024 * 1024));
  originals.set('cancel.bin', digest(path.join(fixture, 'cancel.bin')));
  execFileSync(
    path.join(project, 'build/ffmpeg/ffmpeg.exe'),
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-t',
      '2',
      '-c:v',
      'ffv1',
      path.join(fixture, 'clip.mkv'),
    ],
    { windowsHide: true },
  );
  originals.set('clip.mkv', digest(path.join(fixture, 'clip.mkv')));
  app = await electron.launch({
    executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'),
    args: [project],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: path.join(root, 'data'),
      DISK_ORGANIZER_SCAN_ROOTS: fixture,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await page.locator('.sider-footer button').click();
  await page.locator('.ant-modal:visible .modal-footer-actions button.ant-btn-primary').click();
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描', { timeout: 120000 });
  if (process.env.E2E_APP_PATH) {
    await app.close();
    app = await electron.launch({
      executablePath: process.env.E2E_APP_PATH,
      args: [],
      env: { ...process.env, DISK_ORGANIZER_DATA_DIR: path.join(root, 'data') },
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.app-shell');
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  }
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
});
test.afterAll(async () => {
  if (app) await app.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
test.describe.configure({ mode: 'serial' });

test('非视频提示正确，ZIP可校验名称并保留原文件', async () => {
  await expect(page.locator('.bulk-bar')).toBeHidden();
  await select('pack-000.txt');
  await page.getByRole('button', { name: '压缩视频', exact: true }).click();
  await expect(
    page.getByText('压缩视频仅支持视频文件，请先按视频类型筛选；其他文件可使用压缩打包'),
  ).toBeVisible();
  await page.getByRole('button', { name: '压缩打包', exact: true }).click();
  await expect(modal().getByRole('button', { name: '开始打包', exact: true })).toBeDisabled();
  await outputDialog(true);
  await expect(modal().getByRole('button', { name: '开始打包', exact: true })).toBeDisabled();
  await outputDialog();
  await modal().getByRole('textbox', { name: '压缩包名称' }).fill('../bad');
  await modal().getByRole('button', { name: '开始打包', exact: true }).click();
  await expect(modal()).toContainText('压缩包名称包含无效字符');
  await modal().getByRole('textbox', { name: '压缩包名称' }).fill('精选文件');
  await modal().getByRole('button', { name: '开始打包', exact: true }).click();
  await expect(modal().locator('.archive-result')).toContainText('打包完成', { timeout: 30000 });
  verifyArchive(path.join(output, '精选文件.zip'), ['pack-000.txt']);
  await page.screenshot({ path: 'test-results/archive-completed.png' });
  await modal().getByRole('button', { name: '关闭压缩打包', exact: true }).click();
});

test('全部筛选结果跨页打包为TAR.GZ且内容完整', async () => {
  await page.locator('.files-search input').fill('pack-');
  await expect(page.locator('.files-summary')).toContainText('201');
  await page.locator('.files-panel .ant-table-row input[type=checkbox]').first().click();
  await page.getByRole('button', { name: '选择全部 201 个筛选结果', exact: true }).click();
  await page.getByRole('button', { name: '压缩打包', exact: true }).click();
  await expect(modal()).toContainText('已选择 201 个文件');
  await outputDialog();
  await modal().locator('.ant-select').click();
  await page.locator('.ant-select-item-option[title="TAR.GZ"]').click();
  await modal().getByRole('button', { name: '开始打包', exact: true }).click();
  await expect(modal().locator('.archive-result')).toContainText('已处理 201 / 201', {
    timeout: 30000,
  });
  await expect(modal().locator('.archive-result')).toContainText('打包完成');
  verifyArchive(
    path.join(output, '文件打包.tar.gz'),
    [...originals.keys()].filter((name) => name.startsWith('pack-')),
  );
  await modal().getByRole('button', { name: '关闭压缩打包', exact: true }).click();
});

test('取消打包不损坏原文件或留下临时压缩包', async () => {
  await select('cancel.bin');
  await page.getByRole('button', { name: '压缩打包', exact: true }).click();
  await outputDialog();
  await modal().getByRole('textbox', { name: '压缩包名称' }).fill('cancelled');
  await modal().getByRole('button', { name: '开始打包', exact: true }).click();
  await modal().getByRole('button', { name: '停止打包', exact: true }).click();
  await expect(modal().locator('.archive-result')).toContainText('已取消打包', { timeout: 30000 });
  expect(digest(path.join(fixture, 'cancel.bin'))).toBe(originals.get('cancel.bin'));
  expect(fs.existsSync(path.join(output, 'cancelled.zip'))).toBe(false);
  expect(fs.readdirSync(output).some((name) => name.startsWith('.disk-organizer-'))).toBe(false);
  await modal().getByRole('button', { name: '关闭压缩打包', exact: true }).click();
});

test('文件页所选视频进入视频模块并真实压缩', async () => {
  await select('clip.mkv');
  await page.getByRole('button', { name: '压缩视频', exact: true }).click();
  await expect(page.locator('.video-page')).toContainText(path.join(fixture, 'clip.mkv'));
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, output);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.getByRole('button', { name: '开始压缩', exact: true }).click();
  await expect(page.locator('.video-results')).toContainText('压缩完成，原文件保留', {
    timeout: 60000,
  });
  expect(digest(path.join(fixture, 'clip.mkv'))).toBe(originals.get('clip.mkv'));
  expect(fs.existsSync(path.join(output, 'clip.compressed.mkv'))).toBe(true);
  expect(errors).toEqual([]);
});
