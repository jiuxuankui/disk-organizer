import { describe, expect, it } from 'vitest';
import { ratioPercent, usageLevel, usagePercent } from '../../src/renderer/lib/usage';
import { scanPercent, scanPhaseText } from '../../src/renderer/lib/scan';
import type { ScanProgress } from '../../src/shared/types';

describe('usage helpers', () => {
  it('computes clamped usage percentages', () => {
    expect(usagePercent(80, 100)).toBe(80);
    expect(usagePercent(200, 100)).toBe(100);
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(10, 0)).toBe(0);
    expect(usagePercent(Number.NaN, 100)).toBe(0);
  });

  it('maps usage to color levels at the documented thresholds', () => {
    expect(usageLevel(0)).toBe('normal');
    expect(usageLevel(79.9)).toBe('normal');
    expect(usageLevel(80)).toBe('warning');
    expect(usageLevel(89.9)).toBe('warning');
    expect(usageLevel(90)).toBe('danger');
    expect(usageLevel(100)).toBe('danger');
  });

  it('computes relative bar ratios', () => {
    expect(ratioPercent(50, 100)).toBe(50);
    expect(ratioPercent(200, 100)).toBe(100);
    expect(ratioPercent(0, 100)).toBe(0);
    expect(ratioPercent(10, 0)).toBe(0);
  });
});

function progress(patch: Partial<ScanProgress>): ScanProgress {
  return {
    scanId: 1,
    status: 'indexing',
    phase: 'indexing',
    drives: ['C:'],
    currentPath: '',
    filesFound: 0,
    filesProcessed: 0,
    bytesProcessed: 0,
    startedAt: 0,
    finishedAt: null,
    error: null,
    cleaning: false,
    ...patch,
  };
}

describe('scan progress helpers', () => {
  it('reports zero during enumeration and rounds indexing progress', () => {
    expect(scanPercent(progress({ phase: 'enumerating', filesFound: 500 }))).toBe(0);
    expect(scanPercent(progress({ filesFound: 0 }))).toBe(0);
    expect(scanPercent(progress({ filesFound: 200, filesProcessed: 50 }))).toBe(25);
    expect(scanPercent(progress({ filesFound: 3, filesProcessed: 3 }))).toBe(100);
    expect(scanPercent(progress({ status: 'completed', phase: 'idle' }))).toBe(100);
  });

  it('describes the current phase in Chinese', () => {
    expect(scanPhaseText(progress({ phase: 'enumerating' }))).toBe('正在发现文件');
    expect(scanPhaseText(progress({ phase: 'indexing' }))).toBe('正在统计文件');
    expect(scanPhaseText(progress({ phase: 'committing' }))).toBe('正在写入结果');
    expect(scanPhaseText(progress({ status: 'paused' }))).toBe('已暂停');
  });
});
