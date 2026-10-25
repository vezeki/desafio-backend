/** Counters and gauges the process exposes. Implementations must be safe to call from any instance. */
export interface AppMetrics {
  /** A decision that was stored now: processed, rejected or waiting. Replays are not decisions. */
  transactionSettled(kind: string, status: string): void;
  /** The same request or the same queue message was answered from a stored result. */
  duplicate(source: "http" | "sqs", type: "inbox" | "idempotency"): void;
  /** A retry that is part of normal operation: a lock, a missing reference, a broker blip. */
  retry(reason: string): void;
  /** A queue message was copied to the dead-letter queue. */
  deadLetter(): void;
  /** Two transactions wanted the same wallet row and one had to wait or give up. */
  lockConflict(reason: "deadlock" | "lock_timeout"): void;
  /** Reconciliation found a stored balance that the ledger does not explain. */
  reconciliationDivergence(): void;
  /** Seconds spent deciding one wager transaction. */
  observeProcessing(seconds: number): void;
  /** Unpublished outbox rows, and the age in seconds of the oldest one. */
  setOutbox(pending: number, lagSeconds: number): void;
}

export const APP_METRICS = Symbol("APP_METRICS");

export const noopMetrics: AppMetrics = {
  transactionSettled() {},
  duplicate() {},
  retry() {},
  deadLetter() {},
  lockConflict() {},
  reconciliationDivergence() {},
  observeProcessing() {},
  setOutbox() {},
};

const DATABASE_RETRY_REASONS: Record<string, string> = {
  "40P01": "deadlock",
  "55P03": "lock_timeout",
  "40001": "serialization_failure",
};

/** Maps a Postgres SQLSTATE from a rolled-back transaction onto the retry and lock counters. */
export function recordDatabaseRetry(metrics: AppMetrics, sqlState: string): void {
  const reason = DATABASE_RETRY_REASONS[sqlState] ?? "unknown";
  metrics.retry(reason);
  if (reason === "deadlock" || reason === "lock_timeout") metrics.lockConflict(reason);
}
