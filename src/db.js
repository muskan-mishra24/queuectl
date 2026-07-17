'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// All queuectl state lives under .queuectl/ in the current working directory.
// This is what makes jobs, workers config, and the DLQ survive process restarts.
const DATA_DIR = path.join(process.cwd(), '.queuectl');
const DB_PATH = path.join(DATA_DIR, 'queuectl.db');
const PID_FILE = path.join(DATA_DIR, 'workers.pid');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let dbInstance = null;

/**
 * Returns a shared, process-local SQLite connection.
 * WAL mode + a busy_timeout let multiple worker *processes* hit the same
 * file concurrently: writers queue up instead of throwing SQLITE_BUSY.
 */
function getDb() {
  if (dbInstance) return dbInstance;

  ensureDataDir();
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('busy_timeout = 5000');
  dbInstance.pragma('foreign_keys = ON');

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      locked_by TEXT,
      last_error TEXT,
      last_output TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_state_next_attempt
      ON jobs (state, next_attempt_at);

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Seed default configuration if not already present.
  const defaults = { 'max-retries': '3', 'backoff-base': '2' };
  const insertDefault = dbInstance.prepare(
    'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)'
  );
  const seed = dbInstance.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) insertDefault.run(k, v);
  });
  seed();

  return dbInstance;
}

module.exports = { getDb, DATA_DIR, DB_PATH, PID_FILE, ensureDataDir };
