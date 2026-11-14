import { z } from 'zod';
import { organizeRulesSchema } from '@shared/organize';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDED_PATHS } from '@shared/constants';

export const settingsSchema = z.object({
  scanDrives: z
    .array(z.string().regex(/^[A-Za-z]:$/, '硬盘格式应为 C:'))
    .min(0)
    .max(26),
  excludedPaths: z.array(z.string().trim().min(1)).max(200),
  skipHiddenSystem: z.boolean(),
  autoBackup: z.boolean(),
  organizeRules: organizeRulesSchema.default([]),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  scanDrives: ['C:'],
  excludedPaths: [...DEFAULT_EXCLUDED_PATHS],
  skipHiddenSystem: true,
  autoBackup: true,
  organizeRules: [],
};

export function normalizeSettings(input: AppSettings): AppSettings {
  const seen = new Set<string>();
  const scanDrives: string[] = [];
  for (const drive of input.scanDrives) {
    const letter = `${drive.trim().charAt(0).toUpperCase()}:`;
    if (!/^[A-Z]:$/.test(letter) || seen.has(letter)) continue;
    seen.add(letter);
    scanDrives.push(letter);
  }
  const excludedSeen = new Set<string>();
  const excludedPaths: string[] = [];
  for (const raw of input.excludedPaths) {
    let value = path.win32.normalize(raw.trim());
    value = /^[A-Za-z]:\\$/.test(value) ? value.slice(0, 2) : value.replace(/\\+$/, '');
    const key = value.toLowerCase();
    if (!value || excludedSeen.has(key)) continue;
    excludedSeen.add(key);
    excludedPaths.push(value);
  }
  return {
    scanDrives,
    excludedPaths,
    skipHiddenSystem: input.skipHiddenSystem,
    autoBackup: input.autoBackup,
    organizeRules: input.organizeRules,
  };
}

function pickKnownKeys(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    if (key in source) result[key] = source[key];
  }
  return result as Partial<AppSettings>;
}

export function parseSettings(raw: unknown): AppSettings {
  const candidate = { ...DEFAULT_SETTINGS, ...pickKnownKeys(raw) };
  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) return { ...DEFAULT_SETTINGS };
  return normalizeSettings(parsed.data);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The file is already closed.
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Temp file cleanup is best effort.
    }
  }
}

export class SettingsService {
  private cache: AppSettings | null = null;

  constructor(private readonly filePath: string) {}

  load(): AppSettings {
    if (this.cache) return this.cache;
    let settings: AppSettings;
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      settings = parseSettings(JSON.parse(text));
    } catch {
      settings = { ...DEFAULT_SETTINGS };
      atomicWriteJson(this.filePath, settings);
    }
    this.cache = settings;
    return settings;
  }

  get(): AppSettings {
    return { ...this.load() };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const merged = { ...this.load(), ...patch };
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join('；');
      throw new Error(`设置未保存：${message}`);
    }
    const normalized = normalizeSettings(parsed.data);
    atomicWriteJson(this.filePath, normalized);
    this.cache = normalized;
    return { ...normalized };
  }

  reset(): AppSettings {
    const defaults = { ...DEFAULT_SETTINGS };
    atomicWriteJson(this.filePath, defaults);
    this.cache = defaults;
    return { ...defaults };
  }
}
