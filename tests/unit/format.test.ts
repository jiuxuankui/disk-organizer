import { describe, expect, it } from 'vitest';
import {
  escapeLike,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
  toLikeContains,
} from '../../src/shared/format';

describe('formatBytes', () => {
  it('formats bytes with Chinese-friendly units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10.5 * 1024 * 1024)).toBe('10.5 MB');
    expect(formatBytes(123.4 * 1024 * 1024 * 1024)).toBe('123.4 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });
});

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(200000)).toBe('200,000');
    expect(formatCount(-12345)).toBe('-12,345');
  });
});

describe('formatPercent', () => {
  it('renders percentages without meaningless precision', () => {
    expect(formatPercent(25, 100)).toBe('25%');
    expect(formatPercent(1, 1000)).toBe('0.1%');
    expect(formatPercent(0, 100)).toBe('0%');
    expect(formatPercent(5, 0)).toBe('0%');
  });
});

describe('formatDateTime', () => {
  it('formats local date time', () => {
    const ms = new Date(2026, 10, 13, 9, 5, 30).getTime();
    expect(formatDateTime(ms)).toBe('2026-11-13 09:05');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats scan durations', () => {
    expect(formatDuration(0)).toBe('0秒');
    expect(formatDuration(1500)).toBe('1秒');
    expect(formatDuration(61_000)).toBe('1分1秒');
    expect(formatDuration(3_600_000)).toBe('1小时0分');
    expect(formatDuration(-1)).toBe('0秒');
    expect(formatDuration(Number.NaN)).toBe('0秒');
  });
});

describe('LIKE escaping', () => {
  it('escapes wildcard and escape characters', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(toLikeContains('50%')).toBe('%50\\%%');
  });
});
