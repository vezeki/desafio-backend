import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import type { EventContext } from "../../../src/shared/domain/integration-event.ts";
import { Wallet } from "../../../src/wallet/domain/wallet.ts";
import { WalletBalanceChanged } from "../../../src/wallet/domain/events/wallet-balance-changed.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { FailureCategory, FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction-status.ts";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../../src/wagering/domain/events/wager-transaction-events.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");

/** What actually goes over the wire: plain JSON, no enums or class instances. */
const wire = (event: { toJSON(): unknown }): Record<string, any> => JSON.parse(JSON.stringify(event));

const ctx = (eventId: string, causationId?: string): EventContext => ({
  eventId,
  correlationId: "corr-1",
  ...(causationId ? { causationId } : {}),
  occurredAt: T1,
});

function bet(kind = WagerTransactionKind.Bet, reference?: string) {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("25.00"),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
    createdAt: T0,
  });
}

describe("IntegrationEvent envelope", () => {
  test("toJSON has the required envelope shape, with ISO dates and MoneyProps", () => {
    const transaction = bet();
    transaction.markProcessed(undefined, T1, brl("75.00"));
    const event = WagerTransactionProcessed.from(transaction, ctx("evt-1", "msg-1"));

    expect(wire(event)).toEqual({
      eventId: "evt-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "tx-1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      version: 1,
      data: {
        transactionId: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        status: "PROCESSED",
        money: { amount: "25.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        processedAt: "2026-01-01T00:00:01.000Z",
      },
    });
  });

  test("survives a JSON round-trip unchanged (stable, versionable payload)", () => {
    const transaction = bet();
    transaction.markProcessed(undefined, T1, brl("75.00"));
    const envelope = WagerTransactionProcessed.from(transaction, ctx("evt-1")).toJSON();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    expect("causationId" in envelope).toBe(false);
  });

  test("data is deeply frozen", () => {
    const transaction = bet();
    transaction.markProcessed(undefined, T1, brl("75.00"));
    const event = WagerTransactionProcessed.from(transaction, ctx("evt-1"));
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });
});

describe("WagerTransaction events", () => {
  test("Processed requires a PROCESSED transaction", () => {
    expect(() => WagerTransactionProcessed.from(bet(), ctx("evt-1"))).toThrow();
  });

  test("Rejected carries failureCode and its category", () => {
    const transaction = bet();
    transaction.reject(FailureCode.InsufficientFunds, T1, brl("20.00"));
    const { data } = WagerTransactionRejected.from(transaction, ctx("evt-1")).toJSON();

    expect(data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(data.failureCategory).toBe(FailureCategory.Final);
    expect(data.balanceAfter).toEqual({ amount: "20.00", currency: "BRL" });
    expect(data.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("PendingReference carries attempts and next retry", () => {
    const refund = bet(WagerTransactionKind.Refund, "ext-0");
    refund.markPendingReference(new Date("2026-01-01T00:00:03.000Z"));
    const { data, eventType } = WagerTransactionPendingReference.from(refund, ctx("evt-1")).toJSON();

    expect(eventType).toBe("WagerTransactionPendingReference");
    expect(data.referenceExternalTransactionId).toBe("ext-0");
    expect(data.attempts).toBe(1);
    expect(data.nextRetryAt).toBe("2026-01-01T00:00:03.000Z");
  });
});

describe("WalletBalanceChanged", () => {
  test("describes the ledger movement", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-1",
      at: T0,
    });
    const entry = wallet.debit({ entryId: "entry-2", transactionId: "tx-1", money: brl("80.00"), at: T1 });
    const envelope = wire(WalletBalanceChanged.from(wallet, entry, ctx("evt-2")));

    expect(envelope.aggregateId).toBe("wallet-1");
    expect(envelope.eventType).toBe("WalletBalanceChanged");
    expect(envelope.data).toEqual({
      walletId: "wallet-1",
      playerId: "player-1",
      transactionId: "tx-1",
      ledgerEntryId: "entry-2",
      direction: "DEBIT",
      money: { amount: "80.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "20.00", currency: "BRL" },
      walletVersion: 2,
    });
  });
});
