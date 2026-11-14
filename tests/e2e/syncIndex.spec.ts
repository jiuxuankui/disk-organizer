import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let tempRoot = '';
let fixtureRoot = '';
let dataDir = '';
let trashDir = '';
let app: ElectronApplication;
let page: Page;

const FIXTURE_FILES = [
  ['keep.txt', 'keep this file'],
  ['docs/report.txt', 'quarterly report'],
  ['sub/deep.txt', 'deep file'],
  ['delete-me.bin', 'temporary delete payload'],
] as const;

function writeFixture(): void {
  for (const [relative, content] of FIXTURE_FILES) {
    const target = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const photoDir = path.join(fixtureRoot, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });
  const payload = Buffer.alloc(1.5 * 1024 * 1024, 0x37);
  for (const name of ['cat-a.jpg', 'cat-b.jpg', 'cat-c.jpg']) {
    fs.writeFileSync(path.join(photoDir, name), payload);
  }
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    executablePath: ELECTRON,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: dataDir,
      DISK_ORGANIZER_SCAN_ROOTS: fixtureRoot,
      DISK_ORGANIZER_FAKE_TRASH_DIR: trashDir,
    },
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

async function navTo(label: string): Promise<void> {
  await page.locator('.app-nav').getByText(label, { exact: true }).click();
}

async function scanFixture(): Promise<void> {
  await page.locator('.sider-footer button').click();
  await page.waitForSelector('.ant-modal:visible .scan-drive-list', { timeout: 15000 });
  await page.locator('.ant-modal:visible .modal-footer-actions button.ant-btn-primary').click();
  await page.waitForFunction(
    () => document.querySelector('.sider-status-label')?.textContent?.trim() === '已扫描',
    undefined,
    { timeout: 180000 },
  );
  await page.waitForTimeout(1200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-sync-e2e-'));
  fixtureRoot = path.join(tempRoot, 'fixture');
  dataDir = path.join(tempRoot, 'data');
  trashDir = path.join(tempRoot, 'trash');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  writeFixture();
  await launchApp();
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('外部删除的文件在切回窗口后立即从所有索引界面消失', async () => {
  await scanFixture();
  await navTo('全部文件');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(7);
  await expect(page.locator('.files-page')).toContainText('索引包含 7 个文件');

  await page
    .locator('.files-panel .ant-table-row', { hasText: 'report.txt' })
    .locator('.file-name')
    .click();
  await expect(page.locator('.ant-drawer-content')).toContainText('report.txt');

  fs.rmSync(path.join(fixtureRoot, 'docs', 'report.txt'));
  fs.rmSync(path.join(fixtureRoot, 'photos', 'cat-a.jpg'));

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.ant-message')).toContainText('已自动同步磁盘变化', {
    timeout: 20000,
  });

  await expect(page.locator('.ant-drawer-content')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(5);
  await expect(page.locator('.files-panel')).not.toContainText('report.txt');
  await expect(page.locator('.files-panel')).not.toContainText('cat-a.jpg');
  await expect(page.locator('.files-page')).toContainText('索引包含 5 个文件');
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描');

  await navTo('总览');
  await expect(page.locator('.page-overview')).toContainText('已识别');
  await expect(page.locator('.top-panel').first()).not.toContainText('cat-a.jpg');
});
