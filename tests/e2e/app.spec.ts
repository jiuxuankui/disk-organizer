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
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[renderer error]', message.text());
  });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

async function navTo(label: string): Promise<void> {
  await page.locator('.app-nav').getByText(label, { exact: true }).click();
}

async function waitModalTitle(title: string): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const titles = [
        ...document.querySelectorAll<HTMLElement>(
          '.ant-modal-title, .ant-modal-confirm-title',
        ),
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
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organizer-e2e-'));
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

test('首次启动、扫描并显示总览', async () => {
  await scanFixture();
  await expect(page.locator('.drive-card').first()).toContainText('C:');
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描');
});

test('全部文件页支持筛选、搜索和详情抽屉', async () => {
  await navTo('全部文件');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(7);

  await page.locator('.files-search input').fill('cat-');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(3);
  await page.locator('.files-search input').fill('');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(7);

  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="图片"]').click();
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(3);
  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="全部类型"]').click();
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(7);

  await page
    .locator('.files-panel .ant-table-row', { hasText: 'keep.txt' })
    .locator('.file-name')
    .click();
  await expect(page.locator('.ant-drawer-content')).toContainText('keep.txt');
  await page.locator('.ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-content')).toBeHidden();
});

test('删除预览默认取消，确认后进入假回收站并刷新列表', async () => {
  const deleteMe = path.join(fixtureRoot, 'delete-me.bin');
  const row = page.locator('.files-panel .ant-table-row', { hasText: 'delete-me.bin' });
  await row.locator('input[type=checkbox]').click();
  await page.waitForSelector('.bulk-bar', { timeout: 10000 });
  await page.locator('.bulk-bar button.ant-btn-dangerous').click();
  await waitModalTitle('确认移到回收站');
  const activeText = await page.evaluate(() =>
    (document.activeElement?.textContent ?? '').replace(/\s+/g, ''),
  );
  expect(activeText).toBe('取消');
  await visibleModal()
    .locator('.ant-modal-footer button:not(.ant-btn-dangerous)')
    .click();
  await page.waitForSelector('.ant-modal:visible', { state: 'detached', timeout: 10000 });
  expect(fs.existsSync(deleteMe)).toBe(true);

  await page.locator('.bulk-bar button.ant-btn-dangerous').click();
  await waitModalTitle('确认移到回收站');
  await visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous').click();
  await waitModalTitle('已移到回收站');
  await visibleModal().locator('.ant-modal-footer button.ant-btn-primary').click();
  await page.waitForSelector('.ant-modal:visible', { state: 'detached', timeout: 10000 });

  expect(fs.existsSync(deleteMe)).toBe(false);
  const trashed = fs.readdirSync(trashDir);
  expect(trashed.some((name) => name.endsWith('delete-me.bin'))).toBe(true);
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(6);
  await expect(page.locator('.files-panel')).not.toContainText('delete-me.bin');
});

test('重复文件支持建议勾选和整组删除警告', async () => {
  await navTo('重复文件');
  const scopeSelect = page.locator('.duplicates-page .dup-scope-select');
  await expect(scopeSelect).toBeVisible();
  await expect(scopeSelect).toContainText('C:');
  await page
    .locator('.duplicates-page button')
    .filter({ hasText: '开始查找' })
    .first()
    .click();
  await expect(page.locator('.dup-summary')).toBeVisible({ timeout: 180000 });
  await expect(page.locator('.dup-scope-summary')).toContainText('本次查找范围：C:');
  await expect(page.locator('.dup-group')).toHaveCount(1);

  await page.locator('.dup-group-head').first().click();
  await page.locator('.dup-bulk-actions button').filter({ hasText: '一键按建议勾选' }).click();
  await expect(page.locator('.dup-bulk-summary')).toContainText('已勾选');

  await page.locator('.dup-bulk-actions button').filter({ hasText: '取消选择' }).click();
  const memberChecks = page.locator('.dup-group-body .dup-member input[type=checkbox]');
  await expect(memberChecks).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await memberChecks.nth(index).click();
  }
  await page.locator('.dup-bulk-actions button.ant-btn-dangerous').click();
  await waitModalTitle('确认移到回收站');
  await expect(visibleModal()).toContainText('1 个重复组的所有副本都在待删列表中');
  await expect(visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous')).toBeDisabled();
  await visibleModal().locator('.ant-alert-error input[type=checkbox]').click();
  await expect(visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous')).toBeEnabled();
  await visibleModal()
    .locator('.ant-modal-footer button:not(.ant-btn-dangerous)')
    .click();
  await page.waitForSelector('.ant-modal:visible', { state: 'detached', timeout: 10000 });
  for (const name of ['cat-a.jpg', 'cat-b.jpg', 'cat-c.jpg']) {
    expect(fs.existsSync(path.join(fixtureRoot, 'photos', name))).toBe(true);
  }
});

test('设置保存、排除目录和手动备份', async () => {
  await navTo('设置');
  await page.waitForSelector('.settings-page', { timeout: 15000 });
  await page.locator('.settings-page .ant-input-number-input').first().fill('5');
  await page.locator('.settings-page .ant-space-compact input').fill('C:\\Windows');
  await page.locator('.settings-page button').filter({ hasText: '添加' }).click();
  await page.locator('.settings-page button').filter({ hasText: '保存设置' }).click();
  await expect(page.locator('.ant-message')).toContainText('设置已保存');

  const settingsPath = path.join(dataDir, 'data', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.minDuplicateSize).toBe(5 * 1024 * 1024);
  expect(settings.excludedPaths).toContain('C:\\Windows');

  await page.locator('.settings-page button').filter({ hasText: '立即备份' }).click();
  await expect(page.locator('.ant-message')).toContainText('已创建备份');
  await expect(page.locator('.settings-page .ant-list-item')).toHaveCount(1);
  const backupDir = path.join(dataDir, 'data', 'backup');
  expect(fs.readdirSync(backupDir).some((name) => name.startsWith('index-'))).toBe(true);
});

test('关闭并重启后索引与设置仍然存在', async () => {
  await app.close();
  await launchApp();
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描');
  await navTo('全部文件');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(6);
  await navTo('设置');
  await page.waitForSelector('.settings-page .ant-input-number-input', { timeout: 15000 });
  await expect(page.locator('.settings-page .ant-input-number-input').first()).toHaveValue('5');
});

test('清空数据保留设置和自动备份', async () => {
  await page.locator('.settings-page button').filter({ hasText: '清空数据' }).click();
  await waitModalTitle('清空扫描数据？');
  await expect(visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous')).toBeDisabled();
  await visibleModal().locator('.ant-checkbox-input').click();
  await visibleModal().locator('.ant-modal-footer button.ant-btn-dangerous').click();
  await expect(page.locator('.ant-message')).toContainText('已清空扫描数据');
  await expect(page.locator('.settings-page .ant-list-item')).toHaveCount(2);

  await navTo('全部文件');
  await expect(page.locator('.files-page')).toContainText('还没有扫描过这台电脑');
});
