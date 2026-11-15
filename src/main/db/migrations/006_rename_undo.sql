CREATE TABLE rename_batches (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rename_undo_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES rename_batches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_rename_undo_batch ON rename_undo_items (batch_id, status, id);
