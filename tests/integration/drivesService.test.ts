import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveInfo } from '@shared/types';

const listFixedDrives = vi.fn<() => DriveInfo[]>();

vi.mock('../../src/main/services/windowsService', () => ({
  listFixedDrives: () => listFixedDrives(),
}));

const { DrivesService } = await import('../../src/main/services/drivesService');

function drive(letter: string, ready = true): DriveInfo {
  return {
    letter,
    root: `${letter}\\`,
    label: `${letter} Volume`,
    fileSystem: 'NTFS',
    serial: '0000',
    totalBytes: 100,
    freeBytes: 40,
    type: 3,
    ready,
  };
}

beforeEach(() => {
  listFixedDrives.mockReset();
});

describe('DrivesService', () => {
  it('caches the drive list until a refresh is requested', () => {
    listFixedDrives.mockReturnValue([drive('C:'), drive('D:')]);
    const service = new DrivesService();
    expect(service.list()).toHaveLength(2);
    expect(listFixedDrives).toHaveBeenCalledTimes(1);
    expect(service.list()).toHaveLength(2);
    expect(listFixedDrives).toHaveBeenCalledTimes(1);

    listFixedDrives.mockReturnValue([drive('C:')]);
    expect(service.refresh()).toHaveLength(1);
    expect(listFixedDrives).toHaveBeenCalledTimes(2);
    expect(service.list()).toHaveLength(1);
  });

  it('returns defensive copies so callers cannot mutate the cache', () => {
    listFixedDrives.mockReturnValue([drive('C:')]);
    const service = new DrivesService();
    const first = service.list();
    first[0].letter = 'Z:';
    first[0].freeBytes = 0;
    const second = service.list();
    expect(second[0].letter).toBe('C:');
    expect(second[0].freeBytes).toBe(40);
  });

  it('looks drives up by letter case-insensitively and normalizes the colon', () => {
    listFixedDrives.mockReturnValue([drive('C:'), drive('D:')]);
    const service = new DrivesService();
    expect(service.getByLetter('d')?.letter).toBe('D:');
    expect(service.getByLetter('c:')?.letter).toBe('C:');
    expect(service.getByLetter('Z')).toBeNull();
  });

  it('reports only ready drives as online', () => {
    listFixedDrives.mockReturnValue([drive('C:'), drive('D:', false)]);
    const service = new DrivesService();
    expect(service.onlineLetters()).toEqual(new Set(['C:']));
  });

  it('filters scan drives to online drives and removes duplicates', () => {
    listFixedDrives.mockReturnValue([drive('C:'), drive('D:'), drive('E:', false)]);
    const service = new DrivesService();
    const result = service.validateScanDrives(['c', 'C:', 'D:', 'E:', 'Z:', 'not-a-drive']);
    expect(result.map((item) => item.letter)).toEqual(['C:', 'D:']);
  });

  it('returns an empty list when no requested drives are online', () => {
    listFixedDrives.mockReturnValue([drive('C:')]);
    const service = new DrivesService();
    expect(service.validateScanDrives(['Z:'])).toEqual([]);
  });
});
