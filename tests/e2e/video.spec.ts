import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const project = path.resolve(__dirname, '../..');
let root: string;
let video: string;
let output: string;
let original: string;
let app: ElectronApplication;
let page: Page;
const digest = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-video-e2e-'));
  video = path.join(root, '测试 video.mkv');
  output = path.join(root, 'output');
  fs.mkdirSync(output);
  execFileSync(
    path.join(project, 'build/ffmpeg/ffmpeg.exe'),
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24',
      '-t',
      '6',
      '-c:v',
      'ffv1',
      video,
    ],
    { windowsHide: true },
  );
  original = digest(video);
  app = await electron.launch({
    executablePath:
      process.env.E2E_APP_PATH ?? path.join(project, 'node_modules/electron/dist/electron.exe'),
    args: process.env.E2E_APP_PATH ? [] : [project],
    env: { ...process.env, DISK_ORGANIZER_DATA_DIR: path.join(root, 'data') },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await page.locator('.app-nav').getByText('视频压缩', { exact: true }).click();
});

test.afterAll(async () => {
  if (app) await app.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

async function chooseFiles(files: string[], canceled = false): Promise<void> {
  await app.evaluate(
    ({ dialog }, args) => {
      dialog.showOpenDialog = async () => ({ canceled: args.canceled, filePaths: args.files });
    },
    { files, canceled },
  );
  await page.getByRole('button', { name: '添加视频', exact: true }).click();
}

test('空队列禁用开始，选择取消不添加文件，真实压缩保留原视频', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('button', { name: '开始压缩', exact: true })).toBeDisabled();
  await chooseFiles([], true);
  await expect(page.getByText('不需要先扫描，直接添加本地视频')).toBeVisible();
  await chooseFiles([video]);
  await expect(page.getByRole('button', { name: '开始压缩', exact: true })).toBeDisabled();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, output);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.getByRole('button', { name: '开始压缩', exact: true }).click();
  const progressCard = page.locator('.video-progress');
  await expect(progressCard).toBeVisible({ timeout: 10000 });
  await expect(progressCard).toContainText('总进度');
  await expect(progressCard).toContainText('已用时');
  await expect(progressCard.getByText(/正在(读取视频信息|编码|校验输出|保存)/)).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByLabel('视频压缩总进度')).toBeVisible();
  await expect(page.locator('.video-results')).toContainText('任务已结束', { timeout: 120000 });
  await expect(progressCard).toBeHidden();
  await expect(page.locator('.video-results')).toContainText('压缩完成，原文件保留');
  expect(digest(video)).toBe(original);
  expect(fs.readdirSync(output).filter((file) => file.endsWith('.mkv'))).toHaveLength(1);
  await page.locator('.app-nav').getByText('总览', { exact: true }).click();
  await page.locator('.app-nav').getByText('视频压缩', { exact: true }).click();
  await expect(page.locator('.video-results')).toContainText('任务已结束');
  expect(errors).toEqual([]);
  await page.locator('.video-results').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/video-completed.png', fullPage: true });
});

test('取消压缩保留原文件，导航和空队列仍正常', async () => {
  await chooseFiles([video]);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, output);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.getByRole('button', { name: '开始压缩', exact: true }).click();
  await page.getByRole('button', { name: '停止压缩', exact: true }).click();
  await expect(page.locator('.video-results')).toContainText('任务已取消', { timeout: 30000 });
  expect(digest(video)).toBe(original);
  expect(fs.readdirSync(output).some((file) => file.startsWith('.disk-organizer-video-'))).toBe(
    false,
  );
  await page.getByRole('button', { name: '移出列表', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始压缩', exact: true })).toBeDisabled();
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
  await expect(page.locator('.files-page')).toContainText('还没有扫描过这台电脑');
});
