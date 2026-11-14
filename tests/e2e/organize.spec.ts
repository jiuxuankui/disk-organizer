import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const project = path.resolve(__dirname, '../..');
let root: string;
let fixture: string;
let output: string;
let cross: string;
let trash: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];
const hash = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const modal = () => page.locator('.ant-modal:visible');
const rows = () => page.locator('.organize-preview .ant-table-row');
async function choose(button: string, directory: string, canceled = false): Promise<void> {
  await app.evaluate(
    ({ dialog }, args) => {
      dialog.showOpenDialog = async () => ({
        canceled: args.canceled,
        filePaths: [args.directory],
      });
    },
    { directory, canceled },
  );
  await page.getByRole('button', { name: button, exact: true }).click();
}
async function previewFile(name: string): Promise<void> {
  await page.getByRole('textbox', { name: '文件名包含', exact: true }).fill(name);
  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();
  await expect(rows()).toHaveCount(1);
  await expect(rows()).toContainText(name);
  await rows().locator('input[type=checkbox]').check();
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-organize-e2e-'));
  cross = fs.mkdtempSync(path.join(path.dirname(project), '.tmp-organize-e2e-'));
  fixture = path.join(root, 'source');
  output = path.join(root, 'output');
  trash = path.join(root, 'recoverable');
  for (const dir of [fixture, output, trash]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(fixture, 'report.txt'), 'keep all of this text');
  fs.writeFileSync(path.join(fixture, 'cross.txt'), 'recoverable cross-drive original');
  const large = fs.openSync(path.join(fixture, 'cancel.bin'), 'wx');
  fs.ftruncateSync(large, 256 * 1024 * 1024);
  fs.closeSync(large);
  fs.writeFileSync(path.join(output, 'report.txt'), 'do not overwrite');
  for (let i = 1; i <= 45; i++) {
    fs.writeFileSync(path.join(fixture, `batch-${String(i).padStart(2, '0')}.txt`), `batch ${i}`);
  }
  app = await electron.launch({
    executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'),
    args: [project],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: path.join(root, 'data'),
      DISK_ORGANIZER_SCAN_ROOTS: fixture,
      DISK_ORGANIZER_FAKE_TRASH_DIR: trash,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await page.locator('.sider-footer button').click();
  await page.locator('.ant-modal:visible .modal-footer-actions button.ant-btn-primary').click();
  await expect(page.locator('.sider-status-label')).toHaveText('已扫描', { timeout: 120000 });
  await page.locator('.app-nav').getByText('归类整理', { exact: true }).click();
});
test.afterAll(async () => {
  if (app) await app.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (cross) fs.rmSync(cross, { recursive: true, force: true });
});

test('自定义规则持久化，默认不勾选，取消确认不移动，同盘移动保留同名目标并更新文件页', async () => {
  await expect(page.getByRole('button', { name: '生成整理预览', exact: true })).toBeDisabled();
  await choose('选择来源文件夹', fixture, true);
  await expect(page.getByRole('textbox', { name: '整理来源', exact: true })).toHaveValue('');
  await choose('选择来源文件夹', fixture);
  await page.getByRole('button', { name: '添加规则', exact: true }).click();
  await page.getByRole('textbox', { name: '规则名称', exact: true }).fill('文档归档');
  await page.getByRole('textbox', { name: '扩展名条件', exact: true }).fill('txt');
  await page.getByRole('textbox', { name: '文件名包含', exact: true }).fill('report');
  await choose('选择目标文件夹', output);
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.getByText('归类规则已保存，下次启动仍可使用', { exact: true })).toBeVisible();
  await page.reload();
  await page.waitForSelector('.organize-page');
  await expect(page.getByRole('textbox', { name: '规则名称', exact: true })).toHaveValue(
    '文档归档',
  );
  await choose('选择来源文件夹', fixture);
  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();
  await expect(rows()).toHaveCount(1);
  await expect(rows()).toContainText('report (1).txt');
  await expect(rows().locator('input[type=checkbox]')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '移动所选文件', exact: true })).toBeDisabled();
  await rows().locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: '移动所选文件', exact: true }).click();
  await modal().getByRole('button', { name: '暂不移动', exact: true }).click();
  expect(fs.existsSync(path.join(fixture, 'report.txt'))).toBe(true);
  await page.getByRole('button', { name: '移动所选文件', exact: true }).click();
  await modal().getByRole('button', { name: '确认开始移动', exact: true }).click();
  await expect(page.locator('.organize-results')).toContainText('同盘移动完成');
  expect(fs.readFileSync(path.join(output, 'report.txt'), 'utf8')).toBe('do not overwrite');
  expect(fs.readFileSync(path.join(output, 'report (1).txt'), 'utf8')).toBe(
    'keep all of this text',
  );
  expect(fs.existsSync(path.join(fixture, 'report.txt'))).toBe(false);
  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
  await page.locator('.files-search input').fill('report (1).txt');
  await expect(page.locator('.files-panel .ant-table-row')).toHaveCount(1);
  await expect(page.locator('.files-panel .ant-table-row')).toContainText('report (1).txt');
  await page.locator('.app-nav').getByText('归类整理', { exact: true }).click();
});

test('跨盘移动必须单独勾选确认，校验后的副本和可恢复原件均完整', async () => {
  await choose('选择来源文件夹', fixture);
  await choose('选择目标文件夹', cross);
  await previewFile('cross.txt');
  await expect(rows()).toContainText('跨盘');
  const original = hash(path.join(fixture, 'cross.txt'));
  await page.getByRole('button', { name: '移动所选文件', exact: true }).click();
  const confirm = modal().getByRole('checkbox', { name: '我确认跨盘移动，并保留可恢复原件' });
  await expect(confirm).not.toBeChecked();
  await expect(modal().getByRole('button', { name: '确认开始移动', exact: true })).toBeDisabled();
  await confirm.check();
  await modal().getByRole('button', { name: '确认开始移动', exact: true }).click();
  await expect(page.locator('.organize-results')).toContainText(
    '移动完成，原件在回收站或长路径回收区可还原',
  );
  expect(hash(path.join(cross, 'cross.txt'))).toBe(original);
  expect(fs.existsSync(path.join(fixture, 'cross.txt'))).toBe(false);
  const saved = fs
    .readdirSync(trash)
    .map((name) => path.join(trash, name))
    .filter((file) => fs.statSync(file).isFile());
  expect(saved.some((file) => hash(file) === original)).toBe(true);
  await expect(modal()).toHaveCount(0);
  await page.locator('.organize-results').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/organize-completed.png', animations: 'disabled' });
});

test('停止跨盘任务保留原文件且移除本次临时副本', async () => {
  await page.getByRole('textbox', { name: '扩展名条件', exact: true }).fill('bin');
  await previewFile('cancel.bin');
  await page.getByRole('button', { name: '移动所选文件', exact: true }).click();
  await modal().getByRole('checkbox', { name: '我确认跨盘移动，并保留可恢复原件' }).check();
  await modal().getByRole('button', { name: '确认开始移动', exact: true }).click();
  await page.getByRole('button', { name: '停止整理', exact: true }).click();
  await expect(page.locator('.organize-results')).toContainText('已停止整理', { timeout: 30000 });
  expect(fs.statSync(path.join(fixture, 'cancel.bin')).size).toBe(256 * 1024 * 1024);
  expect(fs.existsSync(path.join(cross, 'cancel.bin'))).toBe(false);
  expect(fs.readdirSync(cross).some((name) => name.startsWith('.disk-organizer-move-'))).toBe(
    false,
  );
  expect(errors).toEqual([]);
});

test('预设规则支持一键添加、编辑目标文件夹并持久化', async () => {
  const removeRule = page.getByRole('button', { name: '移除规则', exact: true });
  while ((await removeRule.count()) > 0) await removeRule.first().click();
  await expect(page.locator('.organize-rule')).toHaveCount(0);

  await page.getByRole('button', { name: '添加预设', exact: true }).click();
  await page.getByRole('menuitem', { name: '图片归档', exact: true }).click();
  await expect(page.locator('.organize-rule')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '规则名称', exact: true })).toHaveValue(
    '图片归档',
  );
  await expect(page.getByText('图片', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '扩展名条件', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: '文件名包含', exact: true })).toHaveValue('');

  await choose('选择目标文件夹', output);
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.getByText('归类规则已保存，下次启动仍可使用', { exact: true })).toBeVisible();

  await page.reload();
  await page.waitForSelector('.organize-page');
  await expect(page.locator('.organize-rule')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '规则名称', exact: true })).toHaveValue(
    '图片归档',
  );
  await expect(page.getByRole('textbox', { name: '规则目标文件夹', exact: true })).toHaveValue(
    output,
  );
});

test('预览分批显示 30 个，滚动到底部再加载剩余项', async () => {
  const removeRule = page.getByRole('button', { name: '移除规则', exact: true });
  while ((await removeRule.count()) > 0) await removeRule.first().click();
  await page.getByRole('button', { name: '添加规则', exact: true }).click();
  await page.getByRole('textbox', { name: '规则名称', exact: true }).fill('批量归档');
  await page.getByRole('textbox', { name: '扩展名条件', exact: true }).fill('txt');
  await page.getByRole('textbox', { name: '文件名包含', exact: true }).fill('batch');
  await choose('选择目标文件夹', output);
  await choose('选择来源文件夹', fixture);
  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();

  await expect(page.getByText(/已显示 30 \/ 45 个/)).toBeVisible();
  await expect(rows()).toHaveCount(30);
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByText(/已显示 45 \/ 45 个/)).toBeVisible();
  await expect(rows()).toHaveCount(45);
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
});

test('下移调整规则顺序，切换优先级改变预览结果', async () => {
  const removeRule = page.getByRole('button', { name: '移除规则', exact: true });
  while ((await removeRule.count()) > 0) await removeRule.first().click();
  await expect(page.locator('.organize-rule')).toHaveCount(0);

  const addRule = async (name: string, target: string): Promise<void> => {
    await page.getByRole('button', { name: '添加规则', exact: true }).click();
    const index = (await page.locator('.organize-rule').count()) - 1;
    const card = page.locator('.organize-rule').nth(index);
    await card.getByRole('textbox', { name: '规则名称', exact: true }).fill(name);
    await card.getByRole('textbox', { name: '扩展名条件', exact: true }).fill('txt');
    await card.getByRole('textbox', { name: '文件名包含', exact: true }).fill('batch-01');
    await app.evaluate(
      ({ dialog }, args) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [args.directory] });
      },
      { directory: target },
    );
    await card.getByRole('button', { name: '选择目标文件夹', exact: true }).click();
  };

  await addRule('跨盘规则', cross);
  await addRule('同盘规则', output);
  await choose('选择来源文件夹', fixture);

  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();
  await expect(rows()).toHaveCount(1);
  await expect(rows()).toContainText('跨盘规则');
  await expect(rows()).toContainText('跨盘');

  await page.getByText('同盘优先', { exact: true }).click();
  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();
  await expect(rows()).toContainText('同盘规则');
  await expect(rows()).toContainText('同盘');

  await page.getByText('按规则顺序', { exact: true }).click();
  await page
    .locator('.organize-rule')
    .first()
    .getByRole('button', { name: '下 移', exact: true })
    .click();
  await expect(
    page.locator('.organize-rule').first().getByRole('textbox', { name: '规则名称', exact: true }),
  ).toHaveValue('同盘规则');
  await page.getByRole('button', { name: '生成整理预览', exact: true }).click();
  await expect(rows()).toContainText('同盘规则');
  await expect(rows()).toContainText('同盘');
});
