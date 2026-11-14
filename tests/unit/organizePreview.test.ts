import { describe, expect, it } from 'vitest';
import {
  hasMoreItems,
  nextVisibleCount,
  ORGANIZE_PREVIEW_BATCH,
} from '../../src/renderer/lib/organizePreview';

describe('organize preview incremental loading', () => {
  it('loads one batch at a time and never exceeds the total', () => {
    expect(ORGANIZE_PREVIEW_BATCH).toBe(30);
    expect(nextVisibleCount(0, 45)).toBe(30);
    expect(nextVisibleCount(30, 45)).toBe(45);
    expect(nextVisibleCount(45, 45)).toBe(45);
    expect(nextVisibleCount(30, 45, 15)).toBe(45);
    expect(nextVisibleCount(10, 45, 15)).toBe(25);
  });

  it('handles small, empty and boundary totals', () => {
    expect(nextVisibleCount(0, 12)).toBe(12);
    expect(nextVisibleCount(0, 0)).toBe(0);
    expect(nextVisibleCount(30, 30)).toBe(30);
    expect(nextVisibleCount(28, 45)).toBe(45);
  });

  it('reports whether more items remain', () => {
    expect(hasMoreItems(0, 45)).toBe(true);
    expect(hasMoreItems(30, 45)).toBe(true);
    expect(hasMoreItems(45, 45)).toBe(false);
    expect(hasMoreItems(0, 0)).toBe(false);
  });
});
