ALTER TABLE duplicate_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE duplicate_runs ADD COLUMN folders_json TEXT NOT NULL DEFAULT '[]';
