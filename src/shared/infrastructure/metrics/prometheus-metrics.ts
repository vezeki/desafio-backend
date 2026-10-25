import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import type { AppMetrics } from "../../application/metrics.ts";

/**
 * One registry per process. Counters only move after a committed decision, so a rolled-back
 * transaction does not show up here.
 */
export class PrometheusMetrics implements AppMetrics {
  readonly registry = new Registry();
  private readonly transactions: Counter<"kind" | "status">;
  private readonly duplicates: Counter<"source" | "type">;
  private readonly retries: Counter<"reason">;
  private readonly deadLetters: Counter;
  private readonly lockConflicts: Counter<"reason">;
  private readonly divergences: Counter;
  private readonly duration: Histogram;
  private readonly outboxPending: Gauge;
  private readonly outboxLag: Gauge;

  constructor() {
    const registers = [this.registry];
    this.transactions = new Counter({
      name: "wager_transactions_total",
      help: "Wager transactions decided and stored, by kind and status",
      labelNames: ["kind", "status"],
      registers,
    });
    this.duplicates = new Counter({
      name: "wager_duplicates_total",
      help: "Stored results returned again, by entry point and how the duplicate was recognized",
      labelNames: ["source", "type"],
      registers,
    });
    this.retries = new Counter({
      name: "wager_retries_total",
      help: "Retries of work that is expected to succeed later",
      labelNames: ["reason"],
      registers,
    });
    this.deadLetters = new Counter({
      name: "sqs_dlq_messages_total",
      help: "Wager messages copied to the dead-letter queue",
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wallet_lock_conflicts_total",
      help: "Deadlocks and lock timeouts while a wallet row was held",
      labelNames: ["reason"],
      registers,
    });
    this.divergences = new Counter({
      name: "reconciliation_divergences_total",
      help: "Reconciliation runs whose stored balance did not match the ledger",
      registers,
    });
    this.duration = new Histogram({
      name: "wager_processing_duration_seconds",
      help: "Time to decide one wager transaction",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.outboxPending = new Gauge({
      name: "outbox_pending_messages",
      help: "Outbox rows not yet marked published",
      registers,
    });
    this.outboxLag = new Gauge({
      name: "outbox_lag_seconds",
      help: "Age of the oldest unpublished outbox row, in seconds",
      registers,
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  transactionSettled(kind: string, status: string): void {
    this.transactions.labels({ kind, status }).inc();
  }

  duplicate(source: "http" | "sqs", type: "inbox" | "idempotency"): void {
    this.duplicates.labels({ source, type }).inc();
  }

  retry(reason: string): void {
    this.retries.labels({ reason }).inc();
  }

  deadLetter(): void {
    this.deadLetters.inc();
  }

  lockConflict(reason: "deadlock" | "lock_timeout"): void {
    this.lockConflicts.labels({ reason }).inc();
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  observeProcessing(seconds: number): void {
    this.duration.observe(seconds);
  }

  setOutbox(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(Math.max(0, lagSeconds));
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
