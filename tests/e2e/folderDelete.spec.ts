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

function writeFixture(): void {
  const files: Array<[string, string]> = [
    ['tree/a.txt', 'tree file a'],
    ['tree/sub/b.txt', 'tree sub file b'],
    ['tree/sub/c.bin', 'tree sub file c'],
    ['keep/k.txt', 'keep file'],
    ['root.txt', 'root file not in any folder'],
  ];
  for (const [relative, content] of files) {
    const target = path.join(fixtureRoot, 'fixture', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    executablePath: ELECTRON,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: dataDir,
      DISK_ORGANIZER_SCAN_ROOTS: path.join(fixtureRoot, 'fixture'),
      DISK_ORGANIZER_FAKE_TRASH_DIR: trashDir,
    },
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

async function waitModalTitle(title: string): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const titles = [
        ...document.querySelectorAll<HTMLElement>('.ant-modal-title, .ant-modal-confirm-title'),
      ];
      return titles.some(
        (element) => element.offsetParent !== null && element.textContent.trim() === expected,
      );
    },
    title,
    { timeout: 30000 },
  );
}

function visibleModal() {
  return page.locator('.ant-modal:visible').last();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-folder-delete-'));
  fixtureRoot = tempRoot;
  dataDir = path.join(tempRoot, 'data');
  trashDir = path.join(tempRoot, 'trash');
  writeFixture();
  await launchApp();
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
  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="文件夹"]').click();
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('文件夹视图展开文件，勾选文件夹与文件后删除并立即刷新', async () => {
  const folderRows = page.locator('.folder-table .folder-row');
  const fileRows = page.locator('.folder-table .folder-file-row');
  await expect(folderRows).toHaveCount(2);

  await page.getByRole('button', { name: '展开 tree', exact: true }).click();
  await expect(fileRows.filter({ hasText: 'a.txt' })).toHaveCount(1);

  const fileCheckbox = page.getByRole('checkbox', { name: '选择文件 a.txt' });
  await fileCheckbox.check();
  await expect(page.locator('.bulk-bar')).toContainText('已选 0 个文件夹');
  await expect(page.locator('.bulk-bar')).toContainText('1 个文件');

  await page.getByRole('checkbox', { name: '选择文件夹 tree' }).check();
  await expect(fileCheckbox).toBeDisabled();
  await expect(fileCheckbox).not.toBeChecked();
  await expect(page.locator('.bulk-bar')).toContainText('已选 1 个文件夹');
  await expect(page.locator('.bulk-bar')).toContainText('共 3 个文件');

  await page.getByRole('button', { name: '展开 keep', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择文件 k.txt' }).check();
  await expect(page.locator('.bulk-bar')).toContainText('、1 个文件');

  await page.locator('.bulk-bar button.ant-btn-dangerous').click();
  await waitModalTitle('确认移到回收站');
  const activeText = await page.evaluate(() =>
    (document.activeElement?.textContent ?? '').replace(/\s+/g, ''),
  );
  expect(activeText).toBe('取消');
  await expect(visibleModal()).toContainText('文件夹会连同其中未被软件索引的文件一起移走');
  await expect(visibleModal()).toContainText('tree');

  await visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous').click();
  await waitModalTitle('已移到回收站');
  await expect(visibleModal()).toContainText('已删除');
  await expect(visibleModal()).toContainText('文件夹');
  await visibleModal().locator('.ant-modal-footer button.ant-btn-primary').click();
  await page.waitForSelector('.ant-modal:visible', { state: 'detached', timeout: 10000 });

  expect(fs.existsSync(path.join(fixtureRoot, 'fixture', 'tree'))).toBe(false);
  expect(fs.existsSync(path.join(fixtureRoot, 'fixture', 'keep', 'k.txt'))).toBe(false);
  const trashed = fs.readdirSync(trashDir);
  expect(trashed.some((name) => name.endsWith('-tree'))).toBe(true);
  expect(trashed.some((name) => name.endsWith('-k.txt'))).toBe(true);

  await expect(page.locator('.folder-table .folder-row')).toHaveCount(0);
  await expect(page.locator('.folder-table')).toContainText('当前条件下没有文件夹');
});
