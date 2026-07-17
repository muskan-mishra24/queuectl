# queuectl
A CLI-based background job queue system. Workers execute shell commands as jobs, failed jobs retry automatically with exponential backoff, and jobs that exhaust their retries are moved to a Dead Letter Queue (DLQ). Everything is persisted to SQLite, so the queue survives restarts.
