import { formatBytes } from './format';

export const COPY = {
  appName: '硬盘整理',
  navOverview: '总览',
  navFiles: '全部文件',
  navSettings: '设置',
  deleteAction: '移到回收站',
  deleteConfirmTitle: '确认移到回收站',
  noScanYet: '还没有扫描过这台电脑',
  recycleBinUnavailable: 'Windows 回收站当前不可用，删除功能已暂停',
  fileMissing: '文件已不存在，可能已被移动或删除，建议重新扫描',
  dataLocalNote: '所有数据只保存在这台电脑，软件不联网',
  partialScanHint: (count: number) => `有 ${count} 个文件没有统计（权限不足、系统占用或被排除）`,
  scanAction: '开始扫描',
  rescanAction: '重新扫描',
  pauseAction: '暂停',
  resumeAction: '继续',
  cancelAction: '取消',
  browseAction: '打开位置',
  copyPathAction: '复制路径',
  viewAllAction: '查看全部',
  scanInProgress: '正在扫描',
  scanPaused: '扫描已暂停',
  scanUpdating: '正在更新数据，当前显示上次结果',
  scanReadOnlyNote: '扫描全程只读，不会修改或删除任何文件',
  offlineDriveWarning: '该盘当前未连接，以下为上次扫描结果',
  firstScanAction: '开始首次扫描',
  setupTitle: '开始扫描',
  setupRescanTitle: '重新扫描',
  setupDrivesLabel: '选择要扫描的硬盘',
  setupExcludedLabel: '已排除的目录',
  setupExcludedNote: '排除目录中的文件不进入索引，可在设置中修改',
  setupSkipHiddenLabel: '跳过隐藏文件和系统文件',
  setupStartAction: '开始扫描',
  unidentifiedTooltip: '包含系统目录、无权限文件、被排除的文件夹和回收站中的文件',
  typeShareNote: '百分比按已识别文件计算',
  loading: '加载中',
  empty: '暂无数据',
} as const;

export function buildDeleteConfirmText(count: number, bytes: number): string {
  return `将把 ${count} 个文件（共 ${formatBytes(bytes)}）移到 Windows 回收站，可在回收站还原。清空回收站后才会释放空间。`;
}

export function buildPartialScanHint(count: number): string {
  return COPY.partialScanHint(count);
}
