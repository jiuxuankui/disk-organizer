import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = path.resolve(__dirname, '../..');
let root: string;
let app: ElectronApplication;
let page: Page;

async function sideBack(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].emit(
      'app-command',
      { preventDefault() {} },
      'browser-backward',
    );
  });
  await page.waitForTimeout(300);
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-back-e2e-'));
  app = await electron.launch({
    executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'),
    args: [project],
    env: { ...process.env, DISK_ORGANIZER_DATA_DIR: path.join(root, 'data') },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
});

test.afterAll(async () => {
  if (app) await app.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('鼠标侧键先关闭弹窗，再逐页返回', async () => {
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
  await expect(page.locator('.files-page')).toBeVisible();
  await page.locator('.app-nav').getByText('设置', { exact: true }).click();
  await expect(page.locator('.settings-page')).toBeVisible();

  await sideBack();
  await expect(page.locator('.files-page')).toBeVisible();
  await expect(page.locator('.settings-page')).toBeHidden();

  await sideBack();
  await expect(page.locator('.settings-page')).toBeHidden();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();

  await sideBack();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
});

test('弹窗打开时侧键只关闭弹窗，不切回页面', async () => {
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
  await page.locator('.sider-footer button').click();
  await expect(page.locator('.ant-modal:visible .scan-drive-list')).toBeVisible();
  await sideBack();
  await expect(page.locator('.ant-modal:visible')).toBeHidden();
  await expect(page.locator('.files-page')).toBeVisible();
  await sideBack();
  await expect(page.locator('.files-page')).toBeHidden();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
});

test('没有原生命令时，渲染进程的鼠标后退事件同样生效', async () => {
  await page.locator('.app-nav').getByText('视频压缩', { exact: true }).click();
  await expect(page.getByText('1. 选择视频')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
});
