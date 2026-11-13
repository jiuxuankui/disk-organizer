import type { ScanProgress } from '@shared/types';

export function scanPercent(scan: ScanProgress): number {
  if (scan.status === 'completed') return 100;
  if (scan.phase === 'enumerating' || scan.filesFound <= 0) return 0;
  return Math.min(100, Math.round((scan.filesProcessed / scan.filesFound) * 100));
}

export function scanPhaseText(scan: ScanProgress): string {
  if (scan.status === 'paused') return '已暂停';
  switch (scan.phase) {
    case 'enumerating':
      return '正在发现文件';
    case 'indexing':
      return '正在统计文件';
    case 'committing':
      return '正在写入结果';
    default:
      return '扫描中';
  }
}
