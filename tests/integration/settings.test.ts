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
      skipHiddenSystem: false,
    });
    expect(updated.scanDrives).toEqual(['D:', 'C:']);
    expect(updated.skipHiddenSystem).toBe(false);

    const second = new SettingsService(filePath);
    expect(second.get().scanDrives).toEqual(['D:', 'C:']);
    expect(second.get().skipHiddenSystem).toBe(false);
  });

  it('rejects invalid updates without overwriting the file', () => {
    const { filePath } = tempSettings();
    const service = new SettingsService(filePath);
    service.load();
    const before = fs.readFileSync(filePath, 'utf8');
    expect(() => service.update({ scanDrives: ['C:\\Windows'] })).toThrow(/设置未保存/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(service.get()).toEqual(DEFAULT_SETTINGS);
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
        autoBackup: false,
        unknownKey: 'ignored',
      }),
    ).toEqual({
      scanDrives: ['C:'],
      excludedPaths: ['C:\\Windows', 'D:\\Private'],
      skipHiddenSystem: true,
      autoBackup: false,
      organizeRules: [],
      organizePriority: 'order',
      theme: 'classic',
    });
  });

  it('persists the selected theme and falls back to classic for unknown values', () => {
    const { filePath } = tempSettings();
    const service = new SettingsService(filePath);
    service.load();
    const updated = service.update({ theme: 'midnight' });
    expect(updated.theme).toBe('midnight');
    const second = new SettingsService(filePath);
    expect(second.get().theme).toBe('midnight');

    expect(
      parseSettings({
        scanDrives: ['D:'],
        excludedPaths: [],
        skipHiddenSystem: false,
        autoBackup: true,
        organizeRules: [],
        organizePriority: 'order',
        theme: 'not-a-theme',
      }),
    ).toMatchObject({ scanDrives: ['D:'], skipHiddenSystem: false, theme: 'classic' });
  });

  it('defaults organizePriority to order for legacy settings and persists changes', () => {
    const { filePath } = tempSettings();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        scanDrives: ['C:'],
        excludedPaths: [],
        skipHiddenSystem: true,
        autoBackup: true,
        organizeRules: [],
      }),
    );
    const service = new SettingsService(filePath);
    expect(service.load().organizePriority).toBe('order');

    const updated = service.update({ organizePriority: 'sameDrive' });
    expect(updated.organizePriority).toBe('sameDrive');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk.organizePriority).toBe('sameDrive');
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
