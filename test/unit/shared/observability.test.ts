import { describe, expect, test } from "bun:test";
import { requestContext } from "../../../src/shared/infrastructure/http/correlation-id.ts";
import { collectLogs, createLogger, PinoNestLogger } from "../../../src/shared/infrastructure/logging/logger.ts";
import { recordDatabaseRetry } from "../../../src/shared/application/metrics.ts";
import { PrometheusMetrics } from "../../../src/shared/infrastructure/metrics/prometheus-metrics.ts";
import { LoggingReconciliationReporter } from "../../../src/wallet/infrastructure/logging-reconciliation-reporter.ts";

function count(text: string, metric: string, labels: Record<string, string> = {}): number {
  const line = text.split("\n").find((entry) => {
    if (!entry.startsWith(metric)) return false;
    return Object.entries(labels).every(([key, value]) => entry.includes(`${key}="${value}"`));
  });
  if (!line || line.startsWith("#")) return 0;
  return Number(line.trim().split(/\s+/).at(-1));
}

describe("metrics", () => {
  test("counters keep the labels the scrape will show", async () => {
    const metrics = new PrometheusMetrics();
    metrics.transactionSettled("BET", "PROCESSED");
    metrics.transactionSettled("BET", "REJECTED");
    metrics.duplicate("http", "idempotency");
    metrics.duplicate("sqs", "inbox");
    metrics.deadLetter();
    metrics.observeProcessing(0.02);
    metrics.setOutbox(3, 1.5);
    recordDatabaseRetry(metrics, "40P01");
    recordDatabaseRetry(metrics, "55P03");
    recordDatabaseRetry(metrics, "40001");

    const text = await metrics.render();
    expect(count(text, "wager_transactions_total", { kind: "BET", status: "PROCESSED" })).toBe(1);
    expect(count(text, "wager_transactions_total", { kind: "BET", status: "REJECTED" })).toBe(1);
    expect(count(text, "wager_duplicates_total", { source: "http", type: "idempotency" })).toBe(1);
    expect(count(text, "wager_duplicates_total", { source: "sqs", type: "inbox" })).toBe(1);
    expect(count(text, "sqs_dlq_messages_total")).toBe(1);
    expect(count(text, "wager_retries_total", { reason: "deadlock" })).toBe(1);
    expect(count(text, "wager_retries_total", { reason: "lock_timeout" })).toBe(1);
    expect(count(text, "wager_retries_total", { reason: "serialization_failure" })).toBe(1);
    expect(count(text, "wallet_lock_conflicts_total", { reason: "deadlock" })).toBe(1);
    expect(count(text, "wallet_lock_conflicts_total", { reason: "lock_timeout" })).toBe(1);
    expect(count(text, "outbox_pending_messages")).toBe(3);
    expect(count(text, "outbox_lag_seconds")).toBe(1.5);
    expect(text).toContain("wager_processing_duration_seconds");
  });

  test("only a divergent reconciliation increments the counter", async () => {
    const metrics = new PrometheusMetrics();
    const reporter = new LoggingReconciliationReporter(metrics);
    const report = {
      walletId: "wallet-1",
      storedBalance: { amount: "10.00", currency: "BRL" },
      calculatedBalance: { amount: "9.00", currency: "BRL" },
      difference: { amount: "1.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    };

    reporter.reconciled(report);
    expect(count(await metrics.render(), "reconciliation_divergences_total")).toBe(0);

    reporter.reconciled({ ...report, consistent: false });
    expect(count(await metrics.render(), "reconciliation_divergences_total")).toBe(1);
  });
});

describe("logs", () => {
  test("the correlation id is on the line and the player id is not", () => {
    const captured = collectLogs();
    const log = createLogger("info", captured.stream);
    requestContext.run({ correlationId: "corr-1" }, () => {
      log.info({ playerId: "player-1", walletId: "wallet-1", money: { amount: "10.00", currency: "BRL" } }, "wager transaction decided");
    });

    const [line] = captured.lines();
    expect(line).toMatchObject({ correlationId: "corr-1", walletId: "wallet-1", msg: "wager transaction decided" });
    expect(line).not.toHaveProperty("playerId");
    expect(line).not.toHaveProperty("money");
  });

  test("Nest's object-and-message calls become one JSON line", () => {
    const captured = collectLogs();
    const nest = new PinoNestLogger(createLogger("info", captured.stream));
    nest.warn({ receiveCount: 2 }, "wager message will be retried");

    expect(captured.lines()[0]).toMatchObject({ receiveCount: 2, msg: "wager message will be retried" });
  });
});
