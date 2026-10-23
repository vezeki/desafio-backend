import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { ExponentialBackoff } from "../../../src/shared/domain/exponential-backoff.ts";
import { InboxMessage } from "../../../src/messaging/domain/inbox-message.ts";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { WagerTransactionProcessed } from "../../../src/wagering/domain/events/wager-transaction-events.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-consumer", payloadHash: "abc", receivedAt: T0 });

  test("starts unprocessed", () => {
    expect(receive().isProcessed()).toBe(false);
  });

  test("markProcessed records the time", () => {
    const message = receive();
    message.markProcessed(at(1));
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe(at(1).toISOString());
  });

  test("cannot be processed twice", () => {
    const message = receive();
    message.markProcessed(at(1));
    expect(() => message.markProcessed(at(2))).toThrow();
  });

  test("detects a reused messageId with a different body", () => {
    const message = receive();
    expect(message.matchesPayload("abc")).toBe(true);
    expect(message.matchesPayload("other")).toBe(false);
  });

  test("requires identity fields", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", receivedAt: T0 })).toThrow();
  });
});

describe("OutboxMessage", () => {
  function event() {
    const transaction = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      createdAt: T0,
    });
    transaction.markProcessed(undefined, T0, Money.from({ amount: "75.00", currency: "BRL" }));
    return WagerTransactionProcessed.from(transaction, { eventId: "evt-1", correlationId: "corr-1", occurredAt: T0 });
  }

  test("enqueue uses the eventId as id and stores the serialized envelope", () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);

    expect(message.id).toBe("evt-1");
    expect(message.aggregateId).toBe("tx-1");
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toEqual(source.toJSON() as unknown as Record<string, unknown>);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  test("markPublished makes it no longer pending nor due", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(1));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(100))).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe(at(1).toISOString());
  });

  test("cannot be published twice", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(1));
    expect(() => message.markPublished(at(2))).toThrow();
    expect(() => message.scheduleRetry(at(2))).toThrow();
  });

  test("scheduleRetry increments attempts and backs off exponentially", () => {
    const backoff = new ExponentialBackoff({ baseDelayMs: 1_000, maxDelayMs: 4_000 });
    const message = OutboxMessage.enqueue(event());

    message.scheduleRetry(at(10), backoff);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.toISOString()).toBe(at(11).toISOString());
    expect(message.isDue(at(10.5))).toBe(false);
    expect(message.isDue(at(11))).toBe(true);

    message.scheduleRetry(at(11), backoff);
    message.scheduleRetry(at(13), backoff);
    message.scheduleRetry(at(17), backoff);
    expect(message.attempts).toBe(4);
    expect(message.nextAttemptAt?.toISOString()).toBe(at(21).toISOString());
  });

  test("never gives up: still pending after many failed attempts", () => {
    const message = OutboxMessage.enqueue(event());
    for (let i = 0; i < 100; i++) message.scheduleRetry(at(i), undefined, () => 0);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt!.getTime() - at(99).getTime()).toBe(5 * 60_000);
  });

  test("lag is measured from occurredAt", () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.lagMs(at(3))).toBe(3_000);
    message.markPublished(at(5));
    expect(message.lagMs(at(60))).toBe(5_000);
  });
});
