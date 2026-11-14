import { describe, expect, it } from 'vitest';
import {
  closeTopOverlay,
  popPage,
  pushBackClose,
  pushPage,
  type PageStack,
} from '../../src/renderer/lib/back';

describe('back navigation', () => {
  it('remembers page visits and walks back through them', () => {
    let stack: PageStack = { page: 'overview', history: [] };
    stack = pushPage(stack, 'files');
    stack = pushPage(stack, 'settings');
    expect(stack).toEqual({ page: 'settings', history: ['overview', 'files'] });
    expect(pushPage(stack, 'settings')).toBe(stack);
    stack = popPage(stack);
    expect(stack).toEqual({ page: 'files', history: ['overview'] });
    stack = popPage(stack);
    expect(stack).toEqual({ page: 'overview', history: [] });
    expect(popPage(stack)).toBe(stack);
  });

  it('falls back to the overview page when there is no history', () => {
    expect(popPage({ page: 'video', history: [] })).toEqual({ page: 'overview', history: [] });
  });

  it('caps remembered pages so long sessions cannot grow without bound', () => {
    let stack: PageStack = { page: 'overview', history: [] };
    const pages = ['files', 'settings', 'video', 'organize'] as const;
    for (let index = 0; index < 80; index += 1) stack = pushPage(stack, pages[index % 4]);
    expect(stack.history).toHaveLength(50);
    expect(stack.page).toBe('organize');
  });

  it('closes the most recently opened overlay first and forgets stale handlers', () => {
    const order: string[] = [];
    const releaseFirst = pushBackClose(() => order.push('first'));
    const releaseSecond = pushBackClose(() => order.push('second'));
    expect(closeTopOverlay()).toBe(true);
    expect(order).toEqual(['second']);
    releaseSecond();
    expect(closeTopOverlay()).toBe(true);
    releaseFirst();
    expect(order).toEqual(['second', 'first']);
    expect(closeTopOverlay()).toBe(false);
  });
});
