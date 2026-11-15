import { RENAME_ITEM_LIMIT } from '@shared/rename';

export function hasFileDrag(types: readonly string[]): boolean {
  return types.includes('Files');
}

export function collectDroppedPaths(
  files: ArrayLike<File>,
  pathOf: (file: File) => string,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    let raw = '';
    try {
      raw = pathOf(file);
    } catch {
      continue;
    }
    const path = raw.trim();
    if (!path) continue;
    const key = path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
    if (paths.length >= RENAME_ITEM_LIMIT) break;
  }
  return paths;
}
