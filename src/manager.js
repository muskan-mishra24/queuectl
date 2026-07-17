'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PID_FILE, DATA_DIR, ensureDataDir } = require('./db');

function readPids() {
  ensureDataDir();
  if (!fs.existsSync(PID_FILE)) return [];
  const content = fs.readFileSync(PID_FILE, 'utf8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid));
}

function writePids(pids) {
  ensureDataDir();
  fs.writeFileSync(PID_FILE, pids.length ? pids.join('\n') + '\n' : '');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `count` independent worker processes, detached from this CLI
 * invocation so they keep running after the `worker start` command returns.
 * PIDs are persisted to .queuectl/workers.pid so `worker stop` can find them.
 */
function startWorkers(count) {
  ensureDataDir();
  const logPath = path.join(DATA_DIR, 'workers.log');
  const logFd = fs.openSync(logPath, 'a');

  const existing = readPids().filter(isAlive);
  const newPids = [];

  for (let i = 0; i < count; i++) {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
      windowsHide: true,
    });
    child.unref();
    newPids.push(child.pid);
  }

  fs.closeSync(logFd);
  writePids([...existing, ...newPids]);
  return { started: newPids, logPath };
}

/**
 * Send SIGTERM to every tracked worker so they can shut down gracefully
 * (finishing whatever job they are currently processing first).
 */
function stopWorkers() {
  const pids = readPids();
  const alive = pids.filter(isAlive);
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* process already gone */
    }
  }
  writePids([]);
  return alive;
}

function listWorkers() {
  const alive = readPids().filter(isAlive);
  // Keep the pid file honest by pruning dead entries.
  writePids(alive);
  return alive;
}

module.exports = { startWorkers, stopWorkers, listWorkers };
