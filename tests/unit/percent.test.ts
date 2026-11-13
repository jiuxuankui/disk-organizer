import { describe, expect, it } from 'vitest';
import { distributePercents, formatPercent1 } from '../../src/shared/percent';

describe('distributePercents', () => {
  it('always totals exactly 100.0 for non-zero values', () => {
    const cases = [
      [1, 1, 1],
      [620, 260, 180, 90, 50],
      [1, 2, 3, 4, 5, 6, 7],
      [999999, 1, 1],
      [1],
      [0, 5, 0, 5],
    ];
    for (const values of cases) {
      const percents = distributePercents(values);
      const sum = percents.reduce((acc, value) => acc + value, 0);
      expect(sum).toBeCloseTo(100, 10);
      expect(percents).toHaveLength(values.length);
    }
  });

  it('returns zeros when there is nothing to divide', () => {
    expect(distributePercents([0, 0, 0])).toEqual([0, 0, 0]);
    expect(distributePercents([])).toEqual([]);
  });

  it('ignores negative and non-finite values', () => {
    const percents = distributePercents([100, -10, Number.NaN, 100]);
    expect(percents).toEqual([50, 0, 0, 50]);
  });

  it('formats one decimal percent', () => {
    expect(formatPercent1(51.25)).toBe('51.3%');
    expect(formatPercent1(0)).toBe('0.0%');
  });
});
