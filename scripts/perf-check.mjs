import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERF_ROOT = path.resolve(
  process.env.DISK_ORGANIZER_PERF_DIR ?? path.join(os.tmpdir(), 'disk-organizer-perf'),
);
const DATA_DIR = path.resolve(
  process.env.DISK_ORGANIZER_PERF_DATA ?? path.join(os.tmpdir(), 'disk-organizer-perf-data'),
);
const REPORT = path.join(APP_DIR, 'PERFORMANCE.md');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function measureIpc(page, query, runs = 5) {
  const samples = await page.evaluate(
    async ({ payload, count }) => {
      const results = [];
      for (let index = 0; index < count; index += 1) {
        const startedAt = performance.now();
        await window.api.queryFiles(payload);
        results.push(performance.now() - startedAt);
      }
      return results;
    },
    { payload: query, count: runs },
  );
  return samples;
}

async function measureOverview(page, runs = 5) {
  const samples = await page.evaluate(async (count) => {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      const startedAt = performance.now();
      await window.api.getOverview();
      results.push(performance.now() - startedAt);
    }
    return results;
  }, runs);
  return samples;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    max: sorted[sorted.length - 1],
  };
}

function dbBytes() {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const target = path.join(DATA_DIR, 'data', `index.db${suffix}`);
    if (fs.existsSync(target)) total += fs.statSync(target).size;
  }
  return total;
}

async function memoryMb(app) {
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
  const totalKb = metrics.reduce((sum, item) => sum + (item.memory?.workingSetSize ?? 0), 0);
  return totalKb / 1024;
}

async function main() {
  assert(fs.existsSync(PERF_ROOT), `性能目录不存在：${PERF_ROOT}，请先运行 npm run seed:perf`);
  assert(
    fs.existsSync(path.join(PERF_ROOT, '.disk-organizer-perf')),
    `性能目录缺少标记文件：${PERF_ROOT}`,
  );
  assert(fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js')), '请先运行 npm run build');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR],
    env: {
      ...process.env,
      DISK_ORGANIZER_DATA_DIR: DATA_DIR,
      DISK_ORGANIZER_SCAN_ROOTS: PERF_ROOT,
    },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForSelector('.app-shell', { timeout: 30000 });

  const rendererLatencies = [];
  let scanDone = false;
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[renderer error]', message.text());
  });

  await page.locator('.sider-footer button').click();
  await page.waitForSelector('.ant-modal:visible .scan-drive-list', { timeout: 15000 });
  const scanStartedAt = performance.now();
  await page.locator('.ant-modal:visible .modal-footer-actions button.ant-btn-primary').click();
  const responsiveness = (async () => {
    while (!scanDone) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (scanDone) break;
      const startedAt = performance.now();
      try {
        await page.evaluate(() => 1 + 1);
        rendererLatencies.push(performance.now() - startedAt);
      } catch {
        break;
      }
    }
  })();
  await page.waitForFunction(
    () => document.querySelector('.sider-status-label')?.textContent?.trim() === '已扫描',
    undefined,
    { timeout: 900000 },
  );
  scanDone = true;
  await responsiveness;
  const scanMs = performance.now() - scanStartedAt;
  await page.waitForTimeout(1200);
  const scanStats = await page.evaluate(() => window.api.getScanState());
  const overview = await page.evaluate(() => window.api.getOverview());
  const scanMemory = await memoryMb(app);
  console.log(`扫描完成：${scanStats.filesProcessed} 个文件，${(scanMs / 1000).toFixed(1)}s`);

  const homeSamples = await measureOverview(page);
  const home = summarize(homeSamples);

  await page.locator('.app-nav').getByText('全部文件', { exact: true }).click();
  const openStartedAt = performance.now();
  await page.waitForSelector('.files-panel .ant-table-row', { timeout: 60000 });
  const filesOpenMs = performance.now() - openStartedAt;
  const baseQuery = {
    drive: null,
    type: null,
    minSize: null,
    maxSize: null,
    mtimeFrom: null,
    mtimeTo: null,
    rootDir: null,
    dirPath: null,
    search: '',
    sortBy: 'size',
    sortOrder: 'desc',
    page: 1,
    pageSize: 200,
  };
  const firstPage = summarize(await measureIpc(page, baseQuery));
  const driveFilter = summarize(await measureIpc(page, { ...baseQuery, drive: 'C:' }));
  const typeFilter = summarize(await measureIpc(page, { ...baseQuery, type: 'document' }));
  const sizeFilter = summarize(await measureIpc(page, { ...baseQuery, minSize: 1024 * 1024 }));
  const searchFilter = summarize(await measureIpc(page, { ...baseQuery, search: 'f000' }));
  const deepPage = summarize(
    await measureIpc(page, { ...baseQuery, page: 501, pageSize: 200 }, 3),
  );
  const filesMemory = await memoryMb(app);

  const peakMemory = await memoryMb(app);

  const appInfo = await page.evaluate(() => window.api.getAppInfo());
  const metrics = {
    scanMs,
    scanFiles: scanStats.filesProcessed,
    scanFound: scanStats.filesFound,
    dbBytes: dbBytes(),
    home,
    filesOpenMs,
    firstPage,
    driveFilter,
    typeFilter,
    sizeFilter,
    searchFilter,
    deepPage,
    rendererMaxMs: rendererLatencies.length > 0 ? Math.max(...rendererLatencies) : 0,
    memoryMb: { afterScan: scanMemory, filesPage: filesMemory, peak: peakMemory },
    filesIndexed: overview?.scan?.totalFiles ?? 0,
  };

  // 程序可能在 Playwright 执行 taskkill 前已自行退出，此时关闭失败不影响已采集的结果。
  await app.close().catch(() => undefined);

  const checks = [
    ['首页查询 ≤ 500ms', home.max <= 500],
    ['全部文件首屏打开 ≤ 2000ms', filesOpenMs <= 2000],
    ['首屏查询 ≤ 1000ms', firstPage.max <= 1000],
    ['硬盘筛选 ≤ 1000ms', driveFilter.max <= 1000],
    ['类型筛选 ≤ 1000ms', typeFilter.max <= 1000],
    ['大小筛选 ≤ 1000ms', sizeFilter.max <= 1000],
    ['搜索 ≤ 1000ms', searchFilter.max <= 1000],
    ['深分页 10 万偏移 ≤ 300ms', deepPage.max <= 300],
    ['扫描期间界面响应 ≤ 500ms', metrics.rendererMaxMs <= 500],
    ['扫描文件数符合预期', metrics.filesIndexed >= 200000],
  ];

  const report = [
    '# 性能验收报告',
    '',
    `- 运行时间：${new Date().toLocaleString('zh-CN')}`,
    `- 测试数据：${PERF_ROOT}`,
    `- 数据目录：${DATA_DIR}`,
    `- 运行环境：Electron ${appInfo?.electron ?? '?'} · Node ${appInfo?.node ?? '?'} · ${appInfo?.platform ?? '?'}`,
    '',
    '## 测试数据规模',
    '',
    `- 索引文件：${metrics.filesIndexed.toLocaleString('zh-CN')} 个`,
    `- 扫描发现：${metrics.scanFound.toLocaleString('zh-CN')} 个`,
    `- 数据库大小：${(metrics.dbBytes / 1024 / 1024).toFixed(1)} MB`,
    '',
    '## 结果',
    '',
    '| 指标 | 结果 | 阈值 | 结论 |',
    '| --- | ---: | ---: | --- |',
    `| 扫描 20 万文件 | ${(metrics.scanMs / 1000).toFixed(1)}s | 记录 | — |`,
    `| 首页查询最大耗时 | ${metrics.home.max.toFixed(0)}ms | ≤ 500ms | ${metrics.home.max <= 500 ? '通过' : '未通过'} |`,
    `| 全部文件首屏 | ${metrics.filesOpenMs.toFixed(0)}ms | ≤ 2000ms | ${metrics.filesOpenMs <= 2000 ? '通过' : '未通过'} |`,
    `| 首屏查询最大耗时 | ${metrics.firstPage.max.toFixed(0)}ms | ≤ 1000ms | ${metrics.firstPage.max <= 1000 ? '通过' : '未通过'} |`,
    `| 硬盘筛选最大耗时 | ${metrics.driveFilter.max.toFixed(0)}ms | ≤ 1000ms | ${metrics.driveFilter.max <= 1000 ? '通过' : '未通过'} |`,
    `| 类型筛选最大耗时 | ${metrics.typeFilter.max.toFixed(0)}ms | ≤ 1000ms | ${metrics.typeFilter.max <= 1000 ? '通过' : '未通过'} |`,
    `| 大小筛选最大耗时 | ${metrics.sizeFilter.max.toFixed(0)}ms | ≤ 1000ms | ${metrics.sizeFilter.max <= 1000 ? '通过' : '未通过'} |`,
    `| 搜索最大耗时 | ${metrics.searchFilter.max.toFixed(0)}ms | ≤ 1000ms | ${metrics.searchFilter.max <= 1000 ? '通过' : '未通过'} |`,
    `| 深分页（第 501 页） | ${metrics.deepPage.max.toFixed(0)}ms | ≤ 300ms | ${metrics.deepPage.max <= 300 ? '通过' : '未通过'} |`,
    `| 扫描期间渲染进程最大响应 | ${metrics.rendererMaxMs.toFixed(0)}ms | ≤ 500ms | ${metrics.rendererMaxMs <= 500 ? '通过' : '未通过'} |`,
    `| 内存（扫描后/文件页/峰值） | ${metrics.memoryMb.afterScan.toFixed(0)} / ${metrics.memoryMb.filesPage.toFixed(0)} / ${metrics.memoryMb.peak.toFixed(0)} MB | 记录 | — |`,
    '',
    '## 结论',
    '',
    ...checks.map(([label, passed]) => `- ${passed ? '通过' : '未通过'}：${label}`),
    '',
  ].join('\n');
  fs.writeFileSync(REPORT, report, 'utf8');
  console.log(report);

  const failed = checks.filter(([, passed]) => !passed);
  if (failed.length > 0) {
    throw new Error(`性能阈值未通过：${failed.map(([label]) => label).join('、')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
