CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE scans (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  drives_json TEXT NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  identified_bytes INTEGER NOT NULL DEFAULT 0,
  skipped_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE drives (
  letter TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  fs TEXT NOT NULL DEFAULT '',
  total_bytes INTEGER NOT NULL,
  free_bytes INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE scan_staging (
  scan_id INTEGER NOT NULL,
  drive TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  PRIMARY KEY (scan_id, path_key)
) WITHOUT ROWID;

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  drive TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  ext TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ctime_ms INTEGER NOT NULL,
  root_dir TEXT NOT NULL,
  dir_path TEXT NOT NULL,
  dir_key TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  UNIQUE (scan_id, path_key)
);

CREATE INDEX idx_files_scan_size ON files (scan_id, size DESC);
CREATE INDEX idx_files_scan_drive_root ON files (scan_id, drive, root_dir);
CREATE INDEX idx_files_scan_dir ON files (scan_id, dir_key);
CREATE INDEX idx_files_scan_name ON files (scan_id, name_key);
CREATE INDEX idx_files_scan_type_size ON files (scan_id, type, size DESC);
CREATE INDEX idx_files_scan_mtime ON files (scan_id, mtime_ms DESC);
CREATE INDEX idx_files_scan_drive_path ON files (scan_id, drive, path_key);
CREATE INDEX idx_files_scan_identity ON files (scan_id, volume_id, file_id);

CREATE TABLE hash_cache (
  path_key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  quick_hash TEXT,
  full_hash TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE duplicate_runs (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  min_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  total_groups INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  reclaimable_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE duplicate_groups (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES duplicate_runs(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  reclaimable_bytes INTEGER NOT NULL,
  type TEXT NOT NULL,
  mixed_ext INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_dup_groups_run ON duplicate_groups (run_id, reclaimable_bytes DESC);

CREATE TABLE duplicate_members (
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  is_suggested_keep INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, file_id)
);
