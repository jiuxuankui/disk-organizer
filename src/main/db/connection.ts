import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { ensureDirectoryForFile, migrate, SchemaTooNewError } from './migrate';

export class DatabaseOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseOpenError';
  }
}

export class DatabaseCorruptError extends DatabaseOpenError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseCorruptError';
  }
}

export interface OpenDatabaseOptions {
  checkIntegrity?: boolean;
  createDirectory?: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCorruptionMessage(message: string): boolean {
  return /not a database|database disk image is malformed|file is encrypted/i.test(message);
}

export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  if (options.createDirectory !== false) {
    try {
      ensureDirectoryForFile(dbPath);
    } catch (error) {
      throw new DatabaseOpenError(`无法创建数据目录：${describe(error)}`, { cause: error });
    }
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    const message = describe(error);
    if (isCorruptionMessage(message)) {
      throw new DatabaseCorruptError('索引数据库文件已损坏，无法读取', { cause: error });
    }
    throw new DatabaseOpenError(`无法打开索引数据库：${message}`, { cause: error });
  }

  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA mmap_size = 268435456;
    `);

    if (options.checkIntegrity !== false) {
      const result = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
      if (!result || result.quick_check !== 'ok') {
        throw new DatabaseCorruptError('索引数据库完整性检查未通过');
      }
    }

    migrate(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while surfacing the original error.
    }
    if (error instanceof DatabaseOpenError || error instanceof SchemaTooNewError) throw error;
    const message = describe(error);
    if (isCorruptionMessage(message)) {
      throw new DatabaseCorruptError('索引数据库文件已损坏，无法读取', { cause: error });
    }
    throw new DatabaseOpenError(`无法初始化索引数据库：${message}`, { cause: error });
  }

  return db;
}

export function databaseExists(dbPath: string): boolean {
  try {
    return fs.statSync(dbPath).isFile();
  } catch {
    return false;
  }
}

export function closeDatabaseQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Already closed or failed; nothing left to release.
  }
}
