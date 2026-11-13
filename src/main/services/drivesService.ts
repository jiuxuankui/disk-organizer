import type { DriveInfo } from '@shared/types';
import { listFixedDrives } from './windowsService';

export class DrivesService {
  private cache: DriveInfo[] = [];

  list(refresh = false): DriveInfo[] {
    if (refresh || this.cache.length === 0) {
      this.cache = listFixedDrives();
    }
    return this.cache.map((drive) => ({ ...drive }));
  }

  refresh(): DriveInfo[] {
    return this.list(true);
  }

  getByLetter(letter: string): DriveInfo | null {
    const normalized = `${letter.trim().charAt(0).toUpperCase()}:`;
    return this.list().find((drive) => drive.letter === normalized) ?? null;
  }

  onlineLetters(): Set<string> {
    return new Set(this.list().filter((drive) => drive.ready).map((drive) => drive.letter));
  }

  validateScanDrives(drives: string[]): DriveInfo[] {
    const online = this.list(true).filter((drive) => drive.ready);
    const onlineMap = new Map(online.map((drive) => [drive.letter, drive]));
    const result: DriveInfo[] = [];
    for (const letter of drives) {
      const normalized = `${letter.trim().charAt(0).toUpperCase()}:`;
      const drive = onlineMap.get(normalized);
      if (drive && !result.some((d) => d.letter === normalized)) result.push(drive);
    }
    return result;
  }
}
