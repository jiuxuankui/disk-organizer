import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SettingsService,
  parseSettings,
} from '../../src/main/services/settingsService';
import { createTempDbPath } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempSettings(): { filePath: string; cleanup(): void } {
  const temp = createTempDbPath('disk-organizer-settings-');
  cleanups.push(temp.cleanup);
  return { filePath: path.join(temp.dir, 'data', 'settings.json'), cleanup: temp.cleanup };
}

describe('settings persistence', () => {
  it('writes defaults on first load', () => {
    const { filePath } = tempSettings();
    const service = new SettingsService(filePath);
    const settings = service.load();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual(DEFAULT_SETTINGS);
  });

  it('persists updates across service instances', () => {
    const { filePath } = tempSettings();
    const first = new SettingsService(filePath);
    first.load();
    const updated = first.update({
      scanDrives: ['d:', 'C:', 'D:'],
      minDuplicateSize: 10 * 1024 * 1024,
      skipHiddenSystem: false,
    });
    expect(updated.scanDrives).toEqual(['D:', 'C:']);
    expect(updated.minDuplicateSize).toBe(10 * 1024 * 1024);
    expect(updated.skipHiddenSystem).toBe(false);

    const second = new SettingsService(filePath);
    expect(second.get().scanDrives).toEqual(['D:', 'C:']);
    expect(second.get().minDuplicateSize).toBe(10 * 1024 * 1024);
  });

  it('rejects invalid updates without overwriting the file', () => {
    const { filePath } = tempSettings();
    const service = new SettingsService(filePath);
    service.load();
    const before = fs.readFileSync(filePath, 'utf8');
    expect(() => service.update({ minDuplicateSize: -5 })).toThrow(/设置未保存/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(service.get().minDuplicateSize).toBe(DEFAULT_SETTINGS.minDuplicateSize);
  });

  it('falls back to defaults for malformed JSON', () => {
    const { filePath } = tempSettings();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not valid json');
    const service = new SettingsService(filePath);
    expect(service.load()).toEqual(DEFAULT_SETTINGS);
    const rewritten = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(rewritten).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown keys and normalizes paths', () => {
    expect(
      parseSettings({
        scanDrives: ['c:', 'C:'],
        excludedPaths: ['C:\\Windows\\', 'c:\\windows', 'D:\\Private'],
        skipHiddenSystem: true,
        minDuplicateSize: 0,
        autoBackup: false,
        unknownKey: 'ignored',
      }),
    ).toEqual({
      scanDrives: ['C:'],
      excludedPaths: ['C:\\Windows', 'D:\\Private'],
      skipHiddenSystem: true,
      minDuplicateSize: 0,
      autoBackup: false,
    });
  });

  it('leaves no temporary files behind', () => {
    const { filePath } = tempSettings();
    const service = new SettingsService(filePath);
    service.load();
    service.update({ autoBackup: false });
    const files = fs.readdirSync(path.dirname(filePath));
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
