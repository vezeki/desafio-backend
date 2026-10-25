import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app.ts";

let api: TestApp;

beforeAll(async () => {
  api = await startTestApp();
});

afterAll(async () => {
  await api.close();
});

function count(text: string, metric: string, labels: Record<string, string> = {}): number {
  const line = text.split("\n").find((entry) => {
    if (!entry.startsWith(metric) || entry.startsWith("#")) return false;
    return Object.entries(labels).every(([key, value]) => entry.includes(`${key}="${value}"`));
  });
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).at(-1));
}

async function scrape(): Promise<{ status: number; contentType: string | null; body: string }> {
  const response = await fetch(`${api.baseUrl}/metrics`);
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

describe("GET /metrics", () => {
  test("a processed bet and its replay show up, and the outbox gauges are present", async () => {
    const playerId = randomUUID();
    const opened = await api.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "100.00", currency: "BRL" } },
      headers: { "x-correlation-id": "corr-metrics" },
    });
    expect(opened.headers.get("x-correlation-id")).toBe("corr-metrics");
    const walletId = opened.body.id as string;
    const externalTransactionId = `tx-${randomUUID()}`;
    const payload = {
      providerId: "provider-a",
      externalTransactionId,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const key = `provider-a:${externalTransactionId}`;

    const before = await scrape();
    const processedBefore = count(before.body, "wager_transactions_total", { kind: "BET", status: "PROCESSED" });
    const duplicatesBefore = count(before.body, "wager_duplicates_total", { source: "http", type: "idempotency" });

    const created = await api.request("POST", "/wagering/transactions", { body: payload, headers: { "idempotency-key": key } });
    expect(created.status).toBe(201);
    const replay = await api.request("POST", "/wagering/transactions", { body: payload, headers: { "idempotency-key": key } });
    expect(replay.status).toBe(200);

    const after = await scrape();
    expect(after.status).toBe(200);
    expect(after.contentType).toContain("text/plain");
    const text = after.body;
    expect(count(text, "wager_transactions_total", { kind: "BET", status: "PROCESSED" })).toBe(processedBefore + 1);
    expect(count(text, "wager_duplicates_total", { source: "http", type: "idempotency" })).toBe(duplicatesBefore + 1);
    expect(text).toContain("wager_processing_duration_seconds");
    expect(text).toContain("outbox_pending_messages");
    expect(text).toContain("outbox_lag_seconds");
    expect(text).not.toContain(playerId);
  });
});
