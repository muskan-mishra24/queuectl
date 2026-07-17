# 📦 queuectl

**A production-style CLI background job queue — with multi-worker processing, automatic retries with exponential backoff, a Dead Letter Queue, and SQLite-backed persistence.**

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Tests](https://img.shields.io/badge/tests-8%20passing-success)
![Storage](https://img.shields.io/badge/storage-SQLite-blue)

---

### ✨ Features

- 🚀 **Multi-worker processing** — run several worker processes in true parallel, no duplicate job execution
- 🔁 **Automatic retries** with configurable exponential backoff
- ☠️ **Dead Letter Queue (DLQ)** for jobs that exhaust all retries
- 💾 **Persistent storage** via SQLite — job state survives restarts
- ⚙️ **Configurable** retry count and backoff base, no hardcoded values
- 🧪 **Fully tested** — end-to-end test suite covering every core scenario
- 🖥️ **Clean CLI** with helpful `--help` output at every level

---

A CLI-based background job queue system. Workers execute shell commands as jobs, failed jobs
retry automatically with exponential backoff, and jobs that exhaust their retries are moved to
a Dead Letter Queue (DLQ). Everything is persisted to SQLite, so the queue survives restarts.
---
## Demo

[Demo video](https://drive.google.com/file/d/1r8gx-7PUUBH-UKsqBMPP_02uRXG9Vj3U/view?usp=drivesdk)

The recording walks through: enqueuing a job that succeeds, enqueuing a job that fails,
starting workers, checking `status`/`list`/`dlq list`, retrying a DLQ job, stopping workers
gracefully, confirming persistence, and running the automated test suite.

---

## 1. Setup Instructions

**Requirements:** Node.js 18+ and npm.

```bash
git clone <your-repo-url>
cd queuectl
npm install

# Option A: run via npm scripts / node directly
node bin/queuectl.js --help

# Option B: install the `queuectl` command globally (recommended)
npm link
queuectl --help
```

`npm link` registers `queuectl` as a global command backed by this repo, so you can run it from
any directory. Each directory you run it from gets its own `.queuectl/` state folder (see
Architecture below) — this is what lets you fully isolate one queue from another.

## 2. Usage Examples

### Enqueue a job

```bash
$ queuectl enqueue '{"id":"job1","command":"echo Hello World"}'
Enqueued job "job1" (state: pending)
```

`id` is optional — omit it and queuectl generates one. `max_retries` is optional too and falls
back to the configured default (see Config below).

### Start workers

```bash
$ queuectl worker start --count 3
Started 3 worker(s): 20481, 20482, 20483
Worker logs: /path/to/cwd/.queuectl/workers.log
```

Workers run as independent, detached OS processes so they keep working after the command
returns, and multiple workers give true parallelism (not just async concurrency in one process).

### Check status

```bash
$ queuectl status
Job states:
STATE       COUNT
----------  -----
pending     0
processing  0
completed   1
failed      0
dead        0

Active workers: 3 (20481, 20482, 20483)
```

### List jobs

```bash
$ queuectl list --state pending
ID    STATE    ATTEMPTS  MAX_RETRIES  COMMAND            UPDATED_AT
----  -------  --------  -----------  -----------------  ------------------------
job2  pending  0         3            sleep 2            2026-07-17T10:11:43.002Z
```

Omit `--state` to list every job regardless of state.

### Dead Letter Queue

```bash
$ queuectl dlq list
ID    ATTEMPTS  COMMAND                       LAST_ERROR                              UPDATED_AT
----  --------  ----------------------------  --------------------------------------  ------------------------
job3  3         does-not-exist                /bin/bash: does-not-exist: not found    2026-07-17T10:12:01.000Z

$ queuectl dlq retry job3
Job "job3" requeued (state: pending)
```

### Configuration

```bash
$ queuectl config set max-retries 5
Set max-retries = 5

$ queuectl config set backoff-base 3
Set backoff-base = 3

$ queuectl config get
backoff-base = 3
max-retries = 5
```

### Stop workers

```bash
$ queuectl worker stop
Sent graceful stop signal to worker(s): 20481, 20482, 20483
```

Workers finish whatever job they're currently running before exiting — no job is killed
mid-execution.

## 3. Architecture Overview

```
bin/queuectl.js   -> executable entry point
src/cli.js        -> Commander.js command definitions (thin - delegates to queue.js/manager.js)
src/queue.js       -> all job/queue/DLQ/config business logic
src/worker.js       -> the worker process loop (runs as its own OS process)
src/manager.js       -> spawns/tracks/stops worker processes, PID file management
src/db.js         -> SQLite connection, schema, pragmas
src/utils.js       -> small helpers (ids, timestamps)
test/run.js        -> end-to-end test suite, runs the real CLI as a subprocess
```

**State directory.** All persistent state lives in `.queuectl/` inside the current working
directory: `queuectl.db` (SQLite database), `workers.pid` (tracked worker PIDs), and
`workers.log` (worker stdout/stderr).

**Job lifecycle.** `pending -> processing -> completed`, or on failure
`pending -> processing -> pending (retry, if attempts < max_retries)` or
`pending -> processing -> dead (DLQ, once attempts reach max_retries)`.
A `dlq retry` moves a `dead` job back to `pending` with `attempts` reset to 0.

**Job claiming / no duplicate processing.** Each worker is a separate OS process, all sharing
one SQLite file in WAL mode. To claim a job, a worker opens a `BEGIN IMMEDIATE` transaction,
which grabs SQLite's write lock immediately rather than optimistically. Within that transaction
it selects the oldest due `pending` job, flips it to `processing` in the same transaction, then
commits. Because the write lock is held for the whole select+update, two workers can never both
claim the same row — a second worker's `BEGIN IMMEDIATE` simply blocks (up to a 5s
`busy_timeout`) until the first transaction commits, at which point the job it wanted is already
`processing`. This is verified in `test/run.js` (20 jobs / 5 workers, each job completes exactly
once).

**Exponential backoff.** On failure, `delay = backoff_base ^ attempts` seconds
(`attempts` is the count *after* this failure). The job's `next_attempt_at` is pushed out by
that many seconds and it goes back to `pending`; workers only claim jobs whose
`next_attempt_at <= now`. Once `attempts >= max_retries`, the job moves to `dead` instead.

**Worker execution.** Commands are run with `child_process.exec` under `/bin/bash`, so both
simple commands (`echo hi`) and shell constructs work. A non-zero exit code (including 127 for
"command not found") is treated as failure and triggers the retry logic above.

**Graceful shutdown.** `worker stop` sends `SIGTERM` to every tracked PID. Each worker's signal
handler only sets an in-memory flag; because the worker loop always awaits the current job to
completion before checking that flag, the in-flight job is allowed to finish normally, and only
then does the process exit.

**Persistence.** All job state lives in SQLite (`.queuectl/queuectl.db`), not in memory, so
`queuectl list`, `queuectl status`, etc. all reflect durable state and survive process restarts.
Because every CLI invocation is itself a fresh Node process re-opening that file, a
"restart" in this system is simply the next command you run.

## 4. Assumptions & Trade-offs

- **One queue per directory.** State is scoped to `.queuectl/` in the current working
  directory, similar to how `git` scopes `.git/`. Running `queuectl` from two different
  directories gives you two independent queues. This keeps the tool dependency-free (no daemon,
  no separate DB server to install) at the cost of needing to `cd` into the right project.
- **Worker processes are unmanaged background processes**, tracked via a PID file, not a
  process supervisor. If a worker is killed with `SIGKILL` (or the machine crashes) while
  holding a job in `processing`, that job will stay `processing` forever rather than being
  automatically reclaimed. A production system would add a `locked_at`/heartbeat column and a
  reaper that requeues jobs whose lock has gone stale; this was left out to keep the scope
  focused on the required feature set.
- **Commands run via `bash -c`,** which is flexible (pipes, `&&`, env vars all work) but means
  a job's `command` string is trusted input — no sandboxing is applied. Acceptable for an
  internal job runner; would need hardening before accepting untrusted input.
- **No job priority or scheduling (`run_at`)** in the base implementation — jobs are processed
  in `next_attempt_at`, then `created_at` order. Listed under bonus features in the assignment
  and intentionally left out of the required scope.
- **Backoff is capped only by `max_retries`**, not by a maximum delay ceiling. With a large
  `backoff-base` and `max_retries`, the last retry's delay could be large; this mirrors the
  assignment's `delay = base ^ attempts` formula literally rather than adding an undocumented cap.
- **SQLite over JSON files.** SQLite's transactions (`BEGIN IMMEDIATE`) give correct
  multi-process locking almost for free, which is exactly the primitive this system needs
  (multiple worker *processes* competing for the same jobs). Plain JSON files would need a
  hand-rolled file-locking scheme to get the same safety guarantee.

## 5. Testing Instructions

Run the automated end-to-end suite (spawns the real CLI, real worker processes, and real shell
commands against temporary directories):

```bash
npm test
# or: node test/run.js
```

It exercises all five required scenarios:

1. A basic job completes successfully.
2. A failing job retries with backoff and eventually moves to the DLQ, and `dlq retry` requeues it.
3. Multiple workers (5) process a batch of jobs (20) with no duplicates and no leftovers.
4. Malformed JSON / missing `command` field are rejected without crashing the CLI.
5. A job enqueued by one CLI invocation is visible from a completely separate invocation
   (proving persistence, since each invocation is a fresh process re-reading SQLite).

You can also exercise it manually — see the Usage Examples section above, or:

```bash
mkdir demo && cd demo
queuectl enqueue "{\"id\":\"a\",\"command\":\"echo works\"}"
queuectl enqueue "{\"id\":\"b\",\"command\":\"exit 1\",\"max_retries\":2}"
queuectl worker start --count 2
# wait a few seconds, then:
queuectl status
queuectl dlq list
queuectl worker stop
```

> **Note on shell quoting:** on Windows PowerShell/cmd, wrap the JSON in double quotes and escape
> inner double quotes with `\"` as shown above (PowerShell doesn't handle single-quoted JSON the
> same way bash does). On macOS/Linux, single quotes around the JSON work fine, e.g.
> `queuectl enqueue '{"id":"a","command":"echo works"}'`.

> **Note on commands:** `echo` and `exit <code>` work as job commands on both Windows and
> macOS/Linux. Unix-only commands like `sleep` are **not** available as job commands on Windows
> by default — if you want a cross-platform "wait" job, use
> `node -e "setTimeout(()=>console.log('done'),2000)"` instead.
