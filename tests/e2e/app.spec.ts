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
  ['docs/2024/q1.txt', 'nested report'],
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

async function expectTotalFiles(count: number): Promise<void> {
  await expect(page.locator('.files-summary')).toContainText(`共 ${count} 个文件`);
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
  await expectTotalFiles(8);

  const nameHeader = page
    .locator('.files-panel .ant-table-thead th')
    .filter({ hasText: '名称' })
    .first();
  const resizeHandle = nameHeader.locator('.files-resize-handle');
  const beforeResize = await nameHeader.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  expect(beforeResize).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2 + 90,
    handleBox!.y + handleBox!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  const afterResize = await nameHeader.boundingBox();
  expect(afterResize!.width).toBeGreaterThan(beforeResize!.width + 50);

  await page.locator('.files-search input').fill('cat-');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(3);
  await page.locator('.files-search input').fill('');
  await expectTotalFiles(8);

  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="图片"]').click();
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(3);
  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="全部类型"]').click();
  await expectTotalFiles(8);

  const folderRows = page.locator('.folder-table .folder-row');
  await page.locator('.files-select').nth(1).click();
  await page.locator('.ant-select-item-option[title="文件夹"]').click();
  await expect(folderRows).toHaveCount(3);
  await expect(folderRows.filter({ hasText: 'photos' })).toHaveCount(1);
  await expect(folderRows.filter({ hasText: 'docs' })).toHaveCount(1);

  await page.getByRole('button', { name: '展开 docs', exact: true }).click();
  await expect(folderRows.filter({ hasText: '2024' })).toHaveCount(1);
  await page.getByRole('button', { name: '展开 2024', exact: true }).click();
  await expect(
    page.locator('.folder-table .folder-file-row').filter({ hasText: 'q1.txt' }),
  ).toHaveCount(1);

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.setMinimumSize(900, 520);
    main.setSize(1100, 560);
  });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '展开 photos', exact: true }).click();
  await page.getByRole('button', { name: '展开 sub', exact: true }).click();
  await expect(page.locator('.folder-table .folder-file-row')).toHaveCount(6);

  const folderBody = page.locator('.folder-table .ant-table-body');
  const scrollable = await folderBody.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
  await folderBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => folderBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('checkbox', { name: '选择文件夹 sub' }).click();
  const bulkBar = page.locator('.bulk-bar');
  await expect(bulkBar).toContainText('1 个文件夹');
  const tableBox = await page.locator('.folder-table-wrap').boundingBox();
  const barBox = await bulkBar.boundingBox();
  expect(tableBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(tableBox!.y + tableBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
  const barButtons = [
    page.getByRole('button', { name: '取消选择', exact: true }),
    page.locator('.bulk-bar button.ant-btn-dangerous'),
  ];
  for (const button of barButtons) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.y).toBeGreaterThanOrEqual(barBox!.y);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(barBox!.y + barBox!.height);
  }
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(bulkBar).toBeHidden();
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.setMinimumSize(1100, 700);
    main.setSize(1280, 800);
  });
  await page.waitForTimeout(300);

  await folderRows.filter({ hasText: 'photos' }).locator('.folder-name-text').click();
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(3);
  await expect(page.locator('.ant-select-selection-item[title="全部类型"]')).toBeVisible();
  await expect(page.locator('.files-tags .ant-tag', { hasText: 'photos' })).toBeVisible();
  await page
    .locator('.files-tags .ant-tag', { hasText: 'photos' })
    .locator('.ant-tag-close-icon')
    .click();
  await expectTotalFiles(8);

  await page
    .locator('.files-panel .ant-table-row', { hasText: 'keep.txt' })
    .locator('.file-name')
    .click();
  await expect(page.locator('.ant-drawer-content')).toContainText('keep.txt');
  await page.locator('.ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-content')).toBeHidden();
});

test('重复文件页支持范围与模式选择，完整比对后显示重复组', async () => {
  await navTo('重复文件');
  await expect(page.locator('.dup-scope-box')).toBeVisible();
  await page.getByText('按硬盘查找', { exact: true }).click();
  await page.locator('.dup-mode-select').click();
  await page.locator('.ant-select-item-option', { hasText: '完整比对' }).click();
  await page.getByRole('button', { name: '开始查找', exact: true }).click();

  await expect(page.locator('.dup-group')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.dup-group')).toContainText('3 个文件');
  await page.locator('.dup-group-head').click();
  await expect(page.locator('.dup-member')).toHaveCount(3);
  await expect(page.locator('.dup-member-name', { hasText: 'cat-a.jpg' })).toBeVisible();

  await page.locator('.dup-mode-select').click();
  await page.locator('.ant-select-item-option', { hasText: '仅文件名' }).click();
  await page.getByRole('button', { name: '重新查找', exact: true }).click();
  await expect(page.locator('.dup-list .ant-empty')).toContainText('没有发现可清理的重复文件', {
    timeout: 60000,
  });
  await navTo('全部文件');
});

test('从全部文件进入批量重命名，预览执行后可整批撤销', async () => {
  await navTo('批量重命名');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [filePath],
      bookmarks: [],
    })) as typeof dialog.showOpenDialog;
  }, path.join(fixtureRoot, 'keep.txt'));
  await page
    .locator('.rename-items-card')
    .getByRole('button', { name: 'file-add 添加文件', exact: true })
    .click();
  await expect(
    page.locator('.rename-items-card .ant-table-row', { hasText: 'keep.txt' }),
  ).toHaveCount(1);

  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folderPath],
      bookmarks: [],
    })) as typeof dialog.showOpenDialog;
  }, path.join(fixtureRoot, 'photos'));
  await page
    .locator('.rename-items-card')
    .getByRole('button', { name: 'folder-add 添加文件夹', exact: true })
    .click();
  await expect(
    page.locator('.rename-items-card .ant-table-row', { hasText: 'photos' }),
  ).toHaveCount(1);
  await expect(page.locator('.rename-items-card')).toContainText('1 个文件、1 个文件夹');

  await page.getByRole('button', { name: '清空列表', exact: true }).click();
  await expect(page.locator('.rename-items-card')).toContainText('还没有添加项目');

  await navTo('全部文件');
  await page.locator('.files-search input').fill('keep.txt');
  const row = page.locator('.files-panel .ant-table-row', { hasText: 'keep.txt' });
  await expect(row).toHaveCount(1);
  await row.locator('input[type=checkbox]').click();
  await page.locator('.bulk-bar').getByRole('button', { name: '批量重命名' }).click();

  await expect(page.locator('.rename-page')).toContainText('批量重命名');
  await expect(page.locator('.rename-page .ant-table-row', { hasText: 'keep.txt' })).toHaveCount(1);

  await page.getByRole('button', { name: '添加规则' }).click();
  await page.locator('.ant-dropdown-menu-item', { hasText: '添加前缀/后缀' }).click();
  await page.getByLabel('添加前缀').fill('E2E-');
  await expect(page.locator('.rename-preview-status', { hasText: '可重命名' })).toHaveCount(1, {
    timeout: 30000,
  });

  await page.getByRole('button', { name: '开始重命名', exact: true }).click();
  await waitModalTitle('确认批量重命名');
  const focused = await page.evaluate(() =>
    (document.activeElement?.textContent ?? '').replace(/\s+/g, ''),
  );
  expect(focused).toBe('暂不重命名');
  await visibleModal().getByRole('button', { name: '暂不重命名' }).click();
  expect(fs.existsSync(path.join(fixtureRoot, 'E2E-keep.txt'))).toBe(false);

  await page.getByRole('button', { name: '开始重命名', exact: true }).click();
  await waitModalTitle('确认批量重命名');
  await page.getByRole('button', { name: '确认开始重命名' }).click();
  await expect(page.locator('.rename-page')).toContainText('重命名任务结束', { timeout: 30000 });
  expect(fs.existsSync(path.join(fixtureRoot, 'keep.txt'))).toBe(false);
  expect(fs.existsSync(path.join(fixtureRoot, 'E2E-keep.txt'))).toBe(true);

  await page
    .locator('.rename-page')
    .getByRole('button', { name: '撤销上次批量', exact: true })
    .first()
    .click();
  await waitModalTitle('撤销上次批量重命名');
  await page.getByRole('button', { name: '确认撤销上次批量' }).click();
  await expect(page.locator('.rename-page')).toContainText('撤销任务结束', { timeout: 30000 });
  expect(fs.existsSync(path.join(fixtureRoot, 'keep.txt'))).toBe(true);
  expect(fs.existsSync(path.join(fixtureRoot, 'E2E-keep.txt'))).toBe(false);

  await navTo('全部文件');
  await page.locator('.files-search input').fill('keep.txt');
  await expect(page.locator('.files-panel .ant-table-row', { hasText: 'keep.txt' })).toHaveCount(1);
  await page.locator('.files-search input').fill('');
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
  await visibleModal().locator('.ant-modal-footer button:not(.ant-btn-dangerous)').click();
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
  await expectTotalFiles(7);
  await expect(page.locator('.files-panel')).not.toContainText('delete-me.bin');
});

test('设置保存、排除目录和手动备份', async () => {
  await navTo('设置');
  await page.waitForSelector('.settings-page', { timeout: 15000 });
  await page.locator('.settings-page .ant-space-compact input').fill('D:\\E2E-Excluded');
  await page.locator('.settings-page button').filter({ hasText: '添加' }).click();
  await page.locator('.settings-page button').filter({ hasText: '保存设置' }).click();
  await expect(page.locator('.ant-message')).toContainText('设置已保存');

  const settingsPath = path.join(dataDir, 'data', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.excludedPaths).toContain('D:\\E2E-Excluded');

  await page.locator('.settings-page button').filter({ hasText: '立即备份' }).click();
  await expect(page.locator('.ant-message')).toContainText('已创建备份');
  await expect(page.locator('.settings-page .ant-list-item')).toHaveCount(1);
  const backupDir = path.join(dataDir, 'data', 'backup');
  expect(fs.readdirSync(backupDir).some((name) => name.startsWith('index-'))).toBe(true);
});

test('设置页切换界面风格并立即生效', async () => {
  await navTo('设置');
  await page.waitForSelector('.theme-grid', { timeout: 15000 });
  await expect(page.locator('.theme-card')).toHaveCount(10);
  const darkTheme = page.getByRole('radio', { name: 'macOS 深色' });
  await expect(darkTheme).toHaveAttribute('aria-checked', 'false');
  await darkTheme.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos-dark');
  await expect(darkTheme).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.ant-message')).toContainText('界面风格已切换');
  const bodyBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(bodyBackground).toBe('rgb(28, 28, 30)');
});

test('关闭并重启后索引与设置仍然存在', async () => {
  await app.close();
  await launchApp();
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos-dark');
  await navTo('全部文件');
  await expectTotalFiles(7);
  await navTo('设置');
  await expect(page.locator('.settings-excluded-list')).toContainText('D:\\E2E-Excluded');
  await expect(page.getByRole('radio', { name: 'macOS 深色' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
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
