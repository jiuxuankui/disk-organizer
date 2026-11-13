import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const total = workerData.total ?? 200000;
const batch = workerData.batch ?? 10000;
const db = new DatabaseSync(workerData.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL
  );
`);

const insert = db.prepare('INSERT INTO files (name, size, mtime_ms) VALUES (?, ?, ?)');

let releaseHalfway = () => {};
const halfwayGate = new Promise((resolve) => {
  releaseHalfway = resolve;
});

parentPort.on('message', (message) => {
  if (message === 'continue') releaseHalfway();
});

for (let i = 0; i < total; i++) {
  if (i % batch === 0) db.exec('BEGIN');
  insert.run(`file-${i}.bin`, (i * 7919) % 100000000, 1700000000000 + i);
  if (i % batch === batch - 1) db.exec('COMMIT');
  if (i === Math.floor(total / 2) - 1) {
    parentPort.postMessage({ type: 'halfway', inserted: i + 1 });
    await halfwayGate;
  }
}
if (total % batch !== 0) db.exec('COMMIT');

db.exec('CREATE INDEX IF NOT EXISTS idx_files_size ON files (size DESC);');
const count = db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
db.close();
parentPort.postMessage({ type: 'done', count });
