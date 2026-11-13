export const APP_DIR_NAME = 'DiskOrganizer';
export const DB_FILE_NAME = 'index.db';
export const SETTINGS_FILE_NAME = 'settings.json';
export const BACKUP_DIR_NAME = 'backup';

export const DEFAULT_MIN_DUPLICATE_SIZE = 1024 * 1024;
export const MIN_DUPLICATE_SIZE_OPTIONS = [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024, 0];
export const QUICK_HASH_BYTES = 64 * 1024;
export const BACKUP_KEEP_COUNT = 3;
export const TOP_LIST_COUNT = 10;
export const PAGE_SIZE = 200;
export const SKIPPED_SAMPLE_LIMIT = 100;

export const SYSTEM_EXCLUDED_DIR_NAMES = [
  '$Recycle.Bin',
  'System Volume Information',
  '.disk-organizer-trash',
];

export const DEFAULT_EXCLUDED_PATHS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

export const DEFAULT_SCAN_DRIVES = ['C:'];

export const DUPLICATE_MEMBER_BATCH = 500;
export const SCAN_BATCH_SIZE = 1000;
