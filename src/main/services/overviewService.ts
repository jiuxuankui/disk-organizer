import type { DatabaseSync } from 'node:sqlite';
import type { DriveInfo, HomeOverview } from '@shared/types';
import { getActiveScanSummary } from '../db/scansRepo';
import { buildDriveOverview } from '../db/overviewRepo';
import { listDriveSnapshots, saveDriveSnapshots } from '../db/drivesRepo';
import type { DrivesService } from './drivesService';

export interface OverviewServiceDeps {
  db: DatabaseSync;
  drives: DrivesService;
  now?: () => number;
}

export class OverviewService {
  private readonly db: DatabaseSync;
  private readonly drives: DrivesService;
  private readonly now: () => number;

  constructor(deps: OverviewServiceDeps) {
    this.db = deps.db;
    this.drives = deps.drives;
    this.now = deps.now ?? Date.now;
  }

  get(): HomeOverview {
    const current = this.drives.refresh();
    try {
      saveDriveSnapshots(this.db, current, this.now());
    } catch {
      // Fresh capacity is still usable even if the snapshot cannot be saved.
    }

    const scan = getActiveScanSummary(this.db);
    const currentByLetter = new Map(current.map((drive) => [drive.letter, drive]));
    const letters = new Set<string>();
    for (const drive of current) letters.add(drive.letter);
    if (scan) for (const letter of scan.drives) letters.add(letter);

    const snapshots = new Map(listDriveSnapshots(this.db).map((drive) => [drive.letter, drive]));
    const ordered = [...letters].sort((a, b) => a.localeCompare(b));
    const infos: DriveInfo[] = ordered.map((letter) => {
      const live = currentByLetter.get(letter);
      if (live) return live;
      const snapshot = snapshots.get(letter);
      if (snapshot) return snapshot;
      return {
        letter,
        root: `${letter}\\`,
        label: '',
        fileSystem: '',
        serial: '',
        totalBytes: 0,
        freeBytes: 0,
        type: 3,
        ready: false,
      };
    });

    return {
      scan,
      drives: infos.map((info) => buildDriveOverview(this.db, scan?.id ?? null, info)),
      totalIdentifiedBytes: scan?.identifiedBytes ?? 0,
      totalFiles: scan?.totalFiles ?? 0,
    };
  }
}
