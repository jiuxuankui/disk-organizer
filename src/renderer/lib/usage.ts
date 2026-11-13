export type UsageLevel = 'normal' | 'warning' | 'danger';

export function usagePercent(usedBytes: number, totalBytes: number): number {
  if (
    !Number.isFinite(usedBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    usedBytes <= 0
  ) {
    return 0;
  }
  return Math.min(100, (usedBytes / totalBytes) * 100);
}

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return 'danger';
  if (percent >= 80) return 'warning';
  return 'normal';
}

export function ratioPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

export const USAGE_COLORS: Record<UsageLevel, string> = {
  normal: '#1677ff',
  warning: '#faad14',
  danger: '#cf1322',
};
