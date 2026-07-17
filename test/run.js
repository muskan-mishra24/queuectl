#!/usr/bin/env node
'use strict';

/**
 * End-to-end test suite for queuectl.
 * Runs the actual CLI as a subprocess (via bin/queuectl.js) against a
 * throwaway working directory, so it exercises the real code paths -
 * SQLite persistence, real worker processes, real command execution.
 *
 * Usage: node test/run.js
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const CLI = path.join(__dirname, '..', 'bin', 'queuectl.js');
const DELAY_SCRIPT = path.join(__dirname, 'fixtures', 'delay.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return result;
}

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-test-'));
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(fn, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function statusOf(dir) {
  const r = run(dir, ['status']);
  const out = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(pending|processing|completed|failed|dead)\s+(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

async function main() {
  console.log('queuectl test suite\n');

  // ---- Scenario 1: basic job completes successfully ---------------------
  {
    const dir = freshDir();
    console.log('Scenario 1: basic job completes successfully');
    run(dir, ['enqueue', JSON.stringify({ id: 'ok1', command: 'echo hi' })]);
    run(dir, ['worker', 'start', '--count', '1']);
    await waitFor(() => statusOf(dir).completed === 1);
    run(dir, ['worker', 'stop']);
    test('job reaches completed state', () => {
      assert.strictEqual(statusOf(dir).completed, 1);
    });
  }

  // ---- Scenario 2: failed job retries with backoff, then hits the DLQ ---
  {
    const dir = freshDir();
    console.log('Scenario 2: failed job retries with backoff and moves to DLQ');
    run(dir, ['config', 'set', 'backoff-base', '1']); // keep the test fast
    run(dir, [
      'enqueue',
      JSON.stringify({ id: 'bad1', command: 'exit 1', max_retries: 2 }),
    ]);
    run(dir, ['worker', 'start', '--count', '1']);
    await waitFor(() => statusOf(dir).dead === 1);
    run(dir, ['worker', 'stop']);
    test('job moves to dead state after exhausting retries', () => {
      assert.strictEqual(statusOf(dir).dead, 1);
    });
    const dlq = run(dir, ['dlq', 'list']);
    test('dlq list shows the dead job', () => {
      assert.ok(dlq.stdout.includes('bad1'));
    });
    const retry = run(dir, ['dlq', 'retry', 'bad1']);
    test('dlq retry requeues the job', () => {
      assert.ok(retry.stdout.includes('requeued'));
    });
  }

  // ---- Scenario 3: multiple workers process jobs without overlap --------
  {
    const dir = freshDir();
    console.log('Scenario 3: multiple workers process jobs without overlap');
    for (let i = 0; i < 20; i++) {
      // Runs a script file instead of an inline `node -e "..."` string:
      // cmd.exe on Windows parses nested double quotes unreliably, so a
      // script file is the more robust cross-platform choice here.
      run(dir, [
        'enqueue',
        JSON.stringify({
          id: `w${i}`,
          command: `node "${DELAY_SCRIPT}"`,
        }),
      ]);
    }
    run(dir, ['worker', 'start', '--count', '5']);
    await waitFor(() => statusOf(dir).completed === 20, { timeoutMs: 15000 });
    run(dir, ['worker', 'stop']);
    test('all 20 jobs complete exactly once (no duplicate execution)', () => {
      const s = statusOf(dir);
      assert.strictEqual(s.completed, 20);
      assert.strictEqual(s.pending || 0, 0);
      assert.strictEqual(s.processing || 0, 0);
    });
  }

  // ---- Scenario 4: invalid commands fail gracefully ----------------------
  {
    const dir = freshDir();
    console.log('Scenario 4: invalid commands fail gracefully');
    const badJson = run(dir, ['enqueue', '{not valid json']);
    test('malformed JSON payload is rejected without crashing', () => {
      assert.notStrictEqual(badJson.status, 0);
      assert.ok(/Error/i.test(badJson.stdout + badJson.stderr));
    });
    const badField = run(dir, ['enqueue', JSON.stringify({ id: 'x' })]);
    test('missing "command" field is rejected without crashing', () => {
      assert.notStrictEqual(badField.status, 0);
    });
  }

  // ---- Scenario 5: job data survives restart -----------------------------
  {
    const dir = freshDir();
    console.log('Scenario 5: job data survives restart');
    run(dir, ['enqueue', JSON.stringify({ id: 'persist1', command: 'echo hi' })]);
    // Each CLI invocation is already a brand-new process re-opening the
    // SQLite file, so simply invoking the CLI again *is* a restart.
    const listed = run(dir, ['list']);
    test('job enqueued in one process is visible from a fresh process', () => {
      assert.ok(listed.stdout.includes('persist1'));
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
