'use strict';

// This file is the entry point for a *worker process*. It is spawned as its
// own OS process by src/manager.js (one process per --count), so that
// multiple workers can truly run in parallel and survive independently.

const { exec } = require('child_process');
const { claimJob, markCompleted, markFailed, getConfig } = require('./queue');

const POLL_INTERVAL_MS = 500;
const workerId = `pid-${process.pid}`;

let shuttingDown = false;

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] [worker ${workerId}] ${msg}\n`);
}

function execCommand(command) {
  return new Promise((resolve) => {
    // No hardcoded shell path here on purpose: Node picks cmd.exe on
    // Windows and /bin/sh on macOS/Linux automatically, so the same code
    // works cross-platform.
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // Covers non-zero exit codes AND "command not found" (exit 127).
        const message = stderr && stderr.trim() ? stderr.trim() : error.message;
        resolve({ success: false, output: stdout, error: message });
      } else {
        resolve({ success: true, output: stdout, error: null });
      }
    });
  });
}

/**
 * Claim and run a single job, if one is available.
 * Returns true if a job was processed, false if the queue was empty.
 */
async function runOnce() {
  const job = claimJob(workerId);
  if (!job) return false;

  log(`picked up job "${job.id}": ${job.command}`);
  const result = await execCommand(job.command);

  if (result.success) {
    markCompleted(job.id, result.output);
    log(`job "${job.id}" completed successfully`);
  } else {
    const backoffBase = parseInt(getConfig('backoff-base') || '2', 10);
    markFailed(job.id, result.error || 'command failed', backoffBase);
    log(`job "${job.id}" failed: ${result.error}`);
  }
  return true;
}

async function loop() {
  log('worker started');
  while (!shuttingDown) {
    // eslint-disable-next-line no-await-in-loop
    const worked = await runOnce();
    if (!worked) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  log('graceful shutdown complete, exiting');
  process.exit(0);
}

// Graceful shutdown: we only flip a flag here. Because runOnce() is always
// awaited to completion inside loop(), any job that is currently executing
// is allowed to finish before the process checks the flag and exits - no
// job is killed mid-flight.
process.on('SIGTERM', () => {
  log('received SIGTERM - finishing current job, then exiting');
  shuttingDown = true;
});
process.on('SIGINT', () => {
  log('received SIGINT - finishing current job, then exiting');
  shuttingDown = true;
});

loop();
