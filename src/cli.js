'use strict';

const { Command } = require('commander');
const queue = require('./queue');
const manager = require('./manager');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue with retries, exponential backoff and a Dead Letter Queue')
  .version('1.0.0');

function printTable(rows, columns) {
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length))
  );
  const pad = (str, w) => String(str ?? '').padEnd(w);

  console.log(columns.map((c, i) => pad(c.label, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(columns.map((c, i) => pad(row[c.key], widths[i])).join('  '));
  }
}

function fail(err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}

// ---- enqueue ----------------------------------------------------------
program
  .command('enqueue <json>')
  .description('Add a new job to the queue. JSON must include "command"; "id" is optional.')
  .action((json) => {
    try {
      const payload = JSON.parse(json);
      const job = queue.enqueue(payload);
      console.log(`Enqueued job "${job.id}" (state: ${job.state})`);
    } catch (err) {
      fail(err);
    }
  });

// ---- worker -------------------------------------------------------------
const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .description('Start one or more worker processes')
  .option('--count <n>', 'number of workers to start', '1')
  .action((opts) => {
    try {
      const count = parseInt(opts.count, 10);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error('--count must be a positive integer');
      }
      const { started, logPath } = manager.startWorkers(count);
      console.log(`Started ${started.length} worker(s): ${started.join(', ')}`);
      console.log(`Worker logs: ${logPath}`);
    } catch (err) {
      fail(err);
    }
  });

worker
  .command('stop')
  .description('Stop all running workers gracefully (SIGTERM; finishes current job first)')
  .action(() => {
    try {
      const stopped = manager.stopWorkers();
      if (!stopped.length) {
        console.log('No running workers found.');
      } else {
        console.log(`Sent graceful stop signal to worker(s): ${stopped.join(', ')}`);
      }
    } catch (err) {
      fail(err);
    }
  });

worker
  .command('list')
  .description('List currently running worker PIDs')
  .action(() => {
    const pids = manager.listWorkers();
    console.log(pids.length ? pids.join('\n') : '(no active workers)');
  });

// ---- status ---------------------------------------------------------------
program
  .command('status')
  .description('Show a summary of all job states and active workers')
  .action(() => {
    try {
      const summary = queue.statusSummary();
      const workers = manager.listWorkers();
      console.log('Job states:');
      printTable(
        Object.entries(summary).map(([state, count]) => ({ state, count })),
        [
          { key: 'state', label: 'STATE' },
          { key: 'count', label: 'COUNT' },
        ]
      );
      console.log(`\nActive workers: ${workers.length}${workers.length ? ' (' + workers.join(', ') + ')' : ''}`);
    } catch (err) {
      fail(err);
    }
  });

// ---- list -------------------------------------------------------------
program
  .command('list')
  .description('List jobs, optionally filtered by state')
  .option('--state <state>', 'filter by state (pending|processing|completed|failed|dead)')
  .action((opts) => {
    try {
      const jobs = queue.listJobs({ state: opts.state });
      printTable(jobs, [
        { key: 'id', label: 'ID' },
        { key: 'state', label: 'STATE' },
        { key: 'attempts', label: 'ATTEMPTS' },
        { key: 'max_retries', label: 'MAX_RETRIES' },
        { key: 'command', label: 'COMMAND' },
        { key: 'updated_at', label: 'UPDATED_AT' },
      ]);
    } catch (err) {
      fail(err);
    }
  });

// ---- dlq ----------------------------------------------------------------
const dlq = program.command('dlq').description('Inspect and manage the Dead Letter Queue');

dlq
  .command('list')
  .description('List jobs that permanently failed and moved to the DLQ')
  .action(() => {
    const jobs = queue.dlqList();
    printTable(jobs, [
      { key: 'id', label: 'ID' },
      { key: 'attempts', label: 'ATTEMPTS' },
      { key: 'command', label: 'COMMAND' },
      { key: 'last_error', label: 'LAST_ERROR' },
      { key: 'updated_at', label: 'UPDATED_AT' },
    ]);
  });

dlq
  .command('retry <id>')
  .description('Requeue a dead job back to pending, resetting its attempt count')
  .action((id) => {
    try {
      const job = queue.dlqRetry(id);
      console.log(`Job "${job.id}" requeued (state: ${job.state})`);
    } catch (err) {
      fail(err);
    }
  });

// ---- config ---------------------------------------------------------------
const config = program.command('config').description('Manage configuration (retry count, backoff base, etc.)');

config
  .command('set <key> <value>')
  .description('Set a config value, e.g. "max-retries 3" or "backoff-base 2"')
  .action((key, value) => {
    try {
      if (!['max-retries', 'backoff-base'].includes(key)) {
        throw new Error(`Unknown config key "${key}". Valid keys: max-retries, backoff-base`);
      }
      if (!/^\d+$/.test(value)) {
        throw new Error(`Value for "${key}" must be a non-negative integer`);
      }
      queue.setConfig(key, value);
      console.log(`Set ${key} = ${value}`);
    } catch (err) {
      fail(err);
    }
  });

config
  .command('get [key]')
  .description('Get one config value, or all values if no key is given')
  .action((key) => {
    if (key) {
      const value = queue.getConfig(key);
      console.log(value === undefined ? `(unset)` : value);
    } else {
      const all = queue.getAllConfig();
      for (const [k, v] of Object.entries(all)) console.log(`${k} = ${v}`);
    }
  });

module.exports = program;
