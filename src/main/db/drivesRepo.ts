import type { DatabaseSync } from 'node:sqlite';
import type { DriveInfo } from '@shared/types';

interface DriveRow {
  letter: string;
  label: string;
  fs: string;
  total_bytes: number;
  free_bytes: number;
  online: number;
  updated_at: number;
}

export function saveDriveSnapshots(db: DatabaseSync, drives: DriveInfo[], now: number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE drives SET online = 0').run();
    const upsert = db.prepare(
      `INSERT INTO drives (letter, label, fs, total_bytes, free_bytes, online, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(letter) DO UPDATE SET
         label = excluded.label,
         fs = excluded.fs,
         total_bytes = excluded.total_bytes,
         free_bytes = excluded.free_bytes,
         online = 1,
         updated_at = excluded.updated_at`,
    );
    for (const drive of drives) {
      upsert.run(
        drive.letter,
        drive.label,
        drive.fileSystem,
        Math.max(0, Math.round(drive.totalBytes)),
        Math.max(0, Math.round(drive.freeBytes)),
        now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction may already be rolled back.
    }
    throw error;
  }
}

export function listDriveSnapshots(db: DatabaseSync): DriveInfo[] {
  const rows = db
    .prepare('SELECT * FROM drives ORDER BY letter')
    .all() as unknown as DriveRow[];
  return rows.map((row) => ({
    letter: row.letter,
    root: `${row.letter}\\`,
    label: row.label,
    fileSystem: row.fs,
    serial: '',
    totalBytes: row.total_bytes,
    freeBytes: row.free_bytes,
    type: 3,
    ready: row.online === 1,
  }));
}
