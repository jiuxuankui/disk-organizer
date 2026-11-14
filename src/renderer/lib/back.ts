import { useEffect } from 'react';

const MAX_HISTORY = 50;
type Close = () => void;
const closers: Close[] = [];

export function pushBackClose(close: Close): () => void {
  closers.push(close);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = closers.lastIndexOf(close);
    if (index >= 0) closers.splice(index, 1);
  };
}

export function closeTopOverlay(): boolean {
  const close = closers.at(-1);
  if (!close) return false;
  close();
  return true;
}

export function useBackClose(active: boolean, close: Close): void {
  useEffect(() => (active ? pushBackClose(close) : undefined), [active, close]);
}

export interface PageStack<Key extends string = string> {
  page: Key;
  history: Key[];
}

export function pushPage<Key extends string>(
  current: PageStack<Key>,
  next: Key,
): PageStack<Key> {
  if (next === current.page) return current;
  return { page: next, history: [...current.history, current.page].slice(-MAX_HISTORY) };
}

export function popPage<Key extends string>(current: PageStack<Key>): PageStack<Key> {
  const history = [...current.history];
  const previous = history.pop();
  if (previous) return { page: previous, history };
  if (current.page !== 'overview') return { page: 'overview' as Key, history: [] };
  return current;
}
