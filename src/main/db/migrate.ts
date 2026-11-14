import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import initSql from './migrations/001_init.sql?raw';
import overviewIndexSql from './migrations/002_overview_index.sql?raw';
import duplicateRunDrivesSql from './migrations/003_duplicate_run_drives.sql?raw';

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: initSql },
  { version: 2, sql: overviewIndexSql },
  { version: 3, sql: duplicateRunDrivesSql },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class SchemaTooNewError extends Error {
  constructor(public readonly foundVersion: number) {
    super(`数据库版本 ${foundVersion} 高于当前软件支持的版本 ${LATEST_SCHEMA_VERSION}`);
    this.name = 'SchemaTooNewError';
  }
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: DatabaseSync): number {
  let current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) throw new SchemaTooNewError(current);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed by SQLite after a hard failure.
      }
      throw error;
    }
    current = migration.version;
  }

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(current));

  return current;
}

export function ensureDirectoryForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
