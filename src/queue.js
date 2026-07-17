'use strict';

const { getDb } = require('./db');
const { nowIso, isoPlusSeconds, generateId } = require('./utils');

const VALID_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

function getConfig(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setConfig(key, value) {
  const db = getDb();
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getAllConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function logEvent(jobId, event, detail) {
  const db = getDb();
  db.prepare(
    'INSERT INTO job_events (job_id, event, detail, created_at) VALUES (?, ?, ?, ?)'
  ).run(jobId, event, detail ? String(detail) : null, nowIso());
}

/**
 * Enqueue a new job. Accepts a parsed object with at least {id, command}.
 * max_retries falls back to the configured default when not supplied.
 */
function enqueue(jobInput) {
  if (!jobInput || typeof jobInput !== 'object') {
    throw new Error('Job payload must be a JSON object');
  }
  if (!jobInput.command || typeof jobInput.command !== 'string') {
    throw new Error('Job payload must include a "command" string');
  }

  const db = getDb();
  const id = jobInput.id ? String(jobInput.id) : generateId();

  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
  if (existing) {
    throw new Error(`Job with id "${id}" already exists`);
  }

  const maxRetries = Number.isFinite(jobInput.max_retries)
    ? jobInput.max_retries
    : parseInt(getConfig('max-retries') || '3', 10);

  const ts = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at, next_attempt_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`
  ).run(id, jobInput.command, maxRetries, ts, ts, ts);

  logEvent(id, 'enqueued', jobInput.command);

  return getJob(id);
}

function getJob(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function listJobs({ state } = {}) {
  const db = getDb();
  if (state) {
    if (!VALID_STATES.includes(state)) {
      throw new Error(`Invalid state "${state}". Must be one of: ${VALID_STATES.join(', ')}`);
    }
    return db
      .prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at')
      .all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at').all();
}

function statusSummary() {
  const db = getDb();
  const rows = db
    .prepare('SELECT state, COUNT(*) as count FROM jobs GROUP BY state')
    .all();
  const summary = Object.fromEntries(VALID_STATES.map((s) => [s, 0]));
  for (const r of rows) summary[r.state] = r.count;
  return summary;
}

function dlqList() {
  return listJobs({ state: 'dead' });
}

/**
 * Move a DLQ (dead) job back to pending, resetting its attempt counter.
 */
function dlqRetry(id) {
  const db = getDb();
  const job = getJob(id);
  if (!job) throw new Error(`Job "${id}" not found`);
  if (job.state !== 'dead') {
    throw new Error(`Job "${id}" is not in the DLQ (state: ${job.state})`);
  }
  const ts = nowIso();
  db.prepare(
    `UPDATE jobs SET state = 'pending', attempts = 0, locked_by = NULL,
       last_error = NULL, updated_at = ?, next_attempt_at = ? WHERE id = ?`
  ).run(ts, ts, id);
  logEvent(id, 'dlq_retry_requeued', null);
  return getJob(id);
}

/**
 * Atomically claim a single pending, due job for a worker.
 * Uses an IMMEDIATE transaction so that concurrent worker *processes*
 * competing for the same SQLite file cannot both claim the same row -
 * the second writer blocks (up to busy_timeout) and then sees the row
 * already flipped to 'processing'.
 */
function claimJob(workerId) {
  const db = getDb();
  const now = nowIso();

  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const job = db
      .prepare(
        `SELECT * FROM jobs
         WHERE state = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT 1`
      )
      .get(now);

    if (!job) {
      db.prepare('COMMIT').run();
      return null;
    }

    db.prepare(
      `UPDATE jobs SET state = 'processing', locked_by = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`
    ).run(workerId, now, job.id);

    db.prepare('COMMIT').run();
    logEvent(job.id, 'claimed', workerId);
    return getJob(job.id);
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

function markCompleted(id, output) {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `UPDATE jobs SET state = 'completed', updated_at = ?, locked_by = NULL,
       last_output = ?, last_error = NULL WHERE id = ?`
  ).run(ts, output ? String(output).slice(0, 4000) : null, id);
  logEvent(id, 'completed', null);
}

/**
 * Record a failed attempt. If attempts have exhausted max_retries the job
 * moves to 'dead' (the DLQ); otherwise it goes back to 'pending' with
 * next_attempt_at pushed out by exponential backoff: delay = base ^ attempts.
 */
function markFailed(id, errorMessage, backoffBase) {
  const db = getDb();
  const job = getJob(id);
  if (!job) return;

  const attempts = job.attempts + 1;
  const ts = nowIso();

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs SET state = 'dead', attempts = ?, updated_at = ?, locked_by = NULL,
         last_error = ? WHERE id = ?`
    ).run(attempts, ts, String(errorMessage).slice(0, 4000), id);
    logEvent(id, 'dead', errorMessage);
    return;
  }

  const delaySeconds = Math.pow(backoffBase, attempts);
  const nextAttemptAt = isoPlusSeconds(delaySeconds);

  db.prepare(
    `UPDATE jobs SET state = 'pending', attempts = ?, updated_at = ?, locked_by = NULL,
       last_error = ?, next_attempt_at = ? WHERE id = ?`
  ).run(attempts, ts, String(errorMessage).slice(0, 4000), nextAttemptAt, id);
  logEvent(id, 'retry_scheduled', `attempt ${attempts}, delay ${delaySeconds}s`);
}

module.exports = {
  VALID_STATES,
  getConfig,
  setConfig,
  getAllConfig,
  enqueue,
  getJob,
  listJobs,
  statusSummary,
  dlqList,
  dlqRetry,
  claimJob,
  markCompleted,
  markFailed,
  logEvent,
};
