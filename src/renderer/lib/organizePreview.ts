export const ORGANIZE_PREVIEW_BATCH = 30;

export function nextVisibleCount(
  loaded: number,
  total: number,
  batch: number = ORGANIZE_PREVIEW_BATCH,
): number {
  const current = Math.max(0, Math.floor(loaded));
  const size = Math.max(1, Math.floor(batch));
  const upper = Math.max(0, Math.floor(total));
  return Math.min(upper, current + size);
}

export function hasMoreItems(loaded: number, total: number): boolean {
  return loaded < total;
}
