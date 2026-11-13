CREATE INDEX idx_files_scan_drive_root_size ON files (scan_id, drive, root_dir, size);
CREATE INDEX idx_files_scan_drive_size ON files (scan_id, drive, size DESC);
CREATE INDEX idx_files_scan_drive_type_size ON files (scan_id, drive, type, size);
