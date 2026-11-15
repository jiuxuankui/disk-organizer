import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let tempRoot = '';
let fixture = '';
let dataDir = '';
let trashDir = '';
let movedOut = '';
let movedAlbum = '';
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const fileRows = () => page.locator('.files-panel .ant-table-row');
const folderRows = () => page.locator('.folder-table .folder-row');
const bulkBar = () => page.locator('.bulk-bar');
const modal = () => page.locator('.ant-modal:visible');

async function stubDialog(directory: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    },
    directory,
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-move-'));
  fixture = path.join(tempRoot, 'fixture');
  dataDir = path.join(tempRoot, 'data');
  trashDir = path.join(tempRoot, 'trash');
  movedOut = path.join(tempRoot, 'moved-out');
  movedAlbum = path.join(tempRoot, 'moved-album');
  for (const dir of [movedOut, movedAlbum]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(fixture, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'inbox', 'move-me.txt'), 'move me');
  fs.mkdirSync(path.join(fixture, 'album', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'album', 'a.txt'), 'album a');
  fs.writeFileSync(path.join(fixture, 'album', 'sub', 'b.txt'), 'album b');
  fs.mkdirSync(path.join(fixture, 'keep'));
  fs.writeFileSync(path.join(fixture, 'keep', 'k.txt'), 'keep');
  fs.writeFileSync(path.join(fixture, 'root.txt'), 'root');
  app = await electron.launch({
    executablePath: ELECTRON,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: dataDir,
      DISK_ORGANIZER_SCAN_ROOTS: fixture,
      DISK_ORGANIZER_FAKE_TRASH_DIR: trashDir,
    },
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell', { timeout: 30000 });
  await page.locator('.sider-footer button').click();
  await page.waitForSelector('.ant-modal:visible .scan-drive-list', { timeout: 15000 });
  await page.locator('.ant-modal:visible .modal-footer-actions button.ant-btn-primary').click();
  await page.waitForFunction(
    () => document.querySelector('.sider-status-label')?.textContent?.trim() === '已扫描',
    undefined,
    { timeout: 180000 },
  );
  await page.waitForTimeout(800);
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('全部文件勾选文件移动到新文件夹，移动后清理变空的来源并刷新列表', async () => {
  await page.locator('.files-search input').fill('move-me.txt');
  await expect(fileRows()).toHaveCount(1);
  await fileRows().first().locator('input[type=checkbox]').check();
  await expect(bulkBar()).toContainText('已选择 1 个文件');
  await bulkBar().getByRole('button', { name: /移动到文件夹/ }).click();

  await expect(modal()).toContainText('移动后不会留下空的来源文件夹');
  await stubDialog(movedOut);
  await modal().getByRole('button', { name: '选择目标文件夹', exact: true }).click();
  await expect(modal()).toContainText('可移动 1 项');
  await modal().getByRole('button', { name: '确认开始移动', exact: true }).click();
  await expect(modal()).toContainText('移动任务结束');
  await expect(modal()).toContainText('已自动清理 1 个因移动变空的来源文件夹');

  expect(fs.readFileSync(path.join(movedOut, 'move-me.txt'), 'utf8')).toBe('move me');
  expect(fs.existsSync(path.join(fixture, 'inbox'))).toBe(false);
  expect(fs.readdirSync(trashDir).some((name) => name.endsWith('-inbox'))).toBe(true);
  expect(errors).toEqual([]);

  await modal().getByRole('button', { name: '关闭移动窗口', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(fileRows()).toHaveCount(1);
  await expect(fileRows().first()).toContainText('moved-out');
});

test('文件夹视图勾选整个文件夹移动，内部文件随目录保留', async () => {
  await page.locator('.files-search input').fill('');
  await expect(fileRows().first()).toBeVisible();
  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="文件夹"]').click();
  await expect(page.getByRole('checkbox', { name: '选择文件夹 album' })).toBeVisible();

  await page.getByRole('checkbox', { name: '选择文件夹 album' }).check();
  await expect(bulkBar()).toContainText('已选 1 个文件夹');
  await bulkBar().getByRole('button', { name: /移动到文件夹/ }).click();
  await stubDialog(movedAlbum);
  await modal().getByRole('button', { name: '选择目标文件夹', exact: true }).click();
  await expect(modal()).toContainText('已选择 0 个文件、1 个文件夹');
  await expect(modal()).toContainText('可移动 1 项');
  await modal().getByRole('button', { name: '确认开始移动', exact: true }).click();
  await expect(modal()).toContainText('移动任务结束');
  await expect(modal()).toContainText('文件夹移动完成');
  await expect(modal().getByText(/已自动清理/)).toHaveCount(0);

  expect(fs.readFileSync(path.join(movedAlbum, 'album', 'a.txt'), 'utf8')).toBe('album a');
  expect(fs.readFileSync(path.join(movedAlbum, 'album', 'sub', 'b.txt'), 'utf8')).toBe('album b');
  expect(fs.existsSync(path.join(fixture, 'album'))).toBe(false);
  expect(fs.readFileSync(path.join(fixture, 'root.txt'), 'utf8')).toBe('root');
  expect(errors).toEqual([]);

  await modal().getByRole('button', { name: '关闭移动窗口', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
  await expect(folderRows().filter({ hasText: 'album' })).toHaveCount(0);
  await expect(page.locator('.folder-table')).toContainText('keep');
});
