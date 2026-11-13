export function distributePercents(values: number[]): number[] {
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const denominator = safe.reduce((sum, value) => sum + value, 0);
  if (denominator <= 0) return safe.map(() => 0);

  const tenths = safe.map((value) => (value / denominator) * 1000);
  const floors = tenths.map((value) => Math.floor(value));
  let remaining = 1000 - floors.reduce((sum, value) => sum + value, 0);
  const order = tenths
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  let index = 0;
  while (remaining > 0 && order.length > 0) {
    result[order[index % order.length].index] += 1;
    remaining -= 1;
    index += 1;
  }
  return result.map((value) => value / 10);
}

export function formatPercent1(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0.0%';
  return `${value.toFixed(1)}%`;
}
