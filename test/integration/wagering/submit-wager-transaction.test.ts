import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InvalidMoneyError } from "../../../src/shared/domain/domain-error.ts";
import { IdempotencyConflictError } from "../../../src/wagering/application/wagering-application-errors.ts";
import { FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { InvalidWagerTransactionError } from "../../../src/wagering/domain/wagering-errors.ts";
import { createTestPersistence, type TestPersistence } from "../../support/orm.ts";
import { expectBalanceMatchesLedger, wageringHarness } from "../../support/wagering.ts";

let p: TestPersistence;
let h: ReturnType<typeof wageringHarness>;

beforeAll(async () => {
  p = await createTestPersistence();
  h = wageringHarness(p);
});

afterAll(async () => {
  await p.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function eventsOf(transactionId: string) {
  const rows = await p.sql`
    select event_type from outbox_messages
    where payload->'data'->>'transactionId' = ${transactionId} order by event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

async function submittedCount(walletId: string) {
  const [row] = await p.sql`
    select count(*)::int as count from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING'`;
  return row.count as number;
}

async function ledgerCount(transactionId: string) {
  const [row] = await p.sql`select count(*)::int as count from wallet_ledger_entries where transaction_id = ${transactionId}`;
  return row.count as number;
}

describe("processing", () => {
  test("a BET debits the wallet and writes ledger and events in the same commit", async () => {
    const wallet = await h.wallet("1000.00");
    const result = await h.send(h.request(wallet, { money: brl("25.00") }));

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction).toMatchObject({ status: "PROCESSED", kind: "BET", balance: brl("975.00") });
    expect(await ledgerCount(result.transaction.transactionId)).toBe(1);
    const events = await p.sql`
      select event_type, payload from outbox_messages
      where payload->'data'->>'transactionId' = ${result.transaction.transactionId} order by event_type`;
    expect(events.map((row: { event_type: string }) => row.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "975.00");
  });

  test("a BET without funds is persisted as REJECTED, with event and without ledger", async () => {
    const wallet = await h.wallet("10.00");
    const result = await h.send(h.request(wallet, { money: brl("10.01") }));

    expect(result.transaction).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
      balance: brl("10.00"),
    });
    expect(await ledgerCount(result.transaction.transactionId)).toBe(0);
    expect(await eventsOf(result.transaction.transactionId)).toEqual(["WagerTransactionRejected"]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "10.00");
  });

  test("LOSS is processed with an event but without balance change", async () => {
    const wallet = await h.wallet("50.00");
    const bet = await h.send(h.request(wallet));
    const loss = await h.send(
      h.request(wallet, { kind: "LOSS", money: brl("0.00"), referenceExternalTransactionId: bet.transaction.externalTransactionId }),
    );

    expect(loss.transaction).toMatchObject({ status: "PROCESSED", referenceTransactionId: bet.transaction.transactionId, balance: brl("40.00") });
    expect(await eventsOf(loss.transaction.transactionId)).toEqual(["WagerTransactionProcessed"]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "40.00");
  });

  test("BET, WIN, REFUND of another BET and ROLLBACK of the WIN keep balance and ledger together", async () => {
    const wallet = await h.wallet("100.00");
    const bet1 = await h.send(h.request(wallet, { money: brl("30.00") }));
    const win = await h.send(h.request(wallet, { kind: "WIN", money: brl("70.00"), referenceExternalTransactionId: bet1.transaction.externalTransactionId }));
    const bet2 = await h.send(h.request(wallet, { roundId: "round-2", money: brl("20.00") }));
    const refund = await h.send(
      h.request(wallet, { kind: "REFUND", roundId: "round-2", money: brl("20.00"), referenceExternalTransactionId: bet2.transaction.externalTransactionId }),
    );
    const rollback = await h.send(
      h.request(wallet, { kind: "ROLLBACK", money: brl("70.00"), referenceExternalTransactionId: win.transaction.externalTransactionId }),
    );

    expect([bet1, win, bet2, refund, rollback].map((r) => [r.transaction.status, r.transaction.balance?.amount])).toEqual([
      ["PROCESSED", "70.00"],
      ["PROCESSED", "140.00"],
      ["PROCESSED", "120.00"],
      ["PROCESSED", "140.00"],
      ["PROCESSED", "70.00"],
    ]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "70.00");
  });

  test("a reference can be reverted only once, by any kind", async () => {
    const wallet = await h.wallet("100.00");
    const bet = await h.send(h.request(wallet, { money: brl("40.00") }));
    const reverse = (kind: string) =>
      h.send(h.request(wallet, { kind, money: brl("40.00"), referenceExternalTransactionId: bet.transaction.externalTransactionId }));

    expect((await reverse("REFUND")).transaction.status).toBe("PROCESSED");
    expect((await reverse("REFUND")).transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await reverse("ROLLBACK")).transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "100.00");
  });

  test("ROLLBACK of a WIN already spent is rejected with REVERSAL_INSUFFICIENT_FUNDS and stays auditable", async () => {
    const wallet = await h.wallet("0.00");
    const win = await h.send(h.request(wallet, { kind: "WIN", money: brl("50.00") }));
    await h.send(h.request(wallet, { money: brl("45.00") }));
    const rollback = await h.send(
      h.request(wallet, { kind: "ROLLBACK", money: brl("50.00"), referenceExternalTransactionId: win.transaction.externalTransactionId }),
    );

    expect(rollback.transaction).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: brl("5.00") });
    const [row] = await p.sql`select status, failure_code from wager_transactions where id = ${rollback.transaction.transactionId}`;
    expect(row).toEqual({ status: "REJECTED", failure_code: "REVERSAL_INSUFFICIENT_FUNDS" });
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "5.00");
  });

  test("a REFUND that arrives before its BET waits as PENDING_REFERENCE", async () => {
    const wallet = await h.wallet("100.00");
    const refund = await h.send(h.request(wallet, { kind: "REFUND", referenceExternalTransactionId: `bet-${randomUUID()}` }));

    expect(refund.transaction).toMatchObject({ status: "PENDING_REFERENCE", referenceAttempts: 1 });
    expect(refund.transaction.nextRetryAt).toEqual(expect.any(String));
    expect(await eventsOf(refund.transaction.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "100.00");
  });

  test("unknown wallet, wallet of another player and another currency are persisted rejections", async () => {
    const wallet = await h.wallet("100.00");
    const unknown = await h.send(h.request({ walletId: randomUUID(), playerId: wallet.playerId }));
    const otherPlayer = await h.send(h.request({ walletId: wallet.walletId, playerId: randomUUID() }));
    const usd = await h.send(h.request(wallet, { money: { amount: "10.00", currency: "USD" } }));

    expect([unknown, otherPlayer, usd].map((r) => [r.transaction.failureCode as string, r.transaction.balance] as const)).toEqual([
      ["WALLET_NOT_FOUND", undefined],
      ["WALLET_PLAYER_MISMATCH", undefined],
      ["CURRENCY_MISMATCH", undefined],
    ]);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "100.00");
  });
});

describe("idempotency", () => {
  test("the same request returns the original result, including the balance observed back then", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet, { money: brl("30.00") });
    const first = await h.send(request);
    await h.send(h.request(wallet, { money: brl("50.00") }));

    const replay = await h.send(request);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction).toEqual(first.transaction);
    expect(replay.transaction.balance).toEqual(brl("70.00"));
    expect(await ledgerCount(first.transaction.transactionId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "20.00");
  });

  test("a rejection is replayed as the same rejection", async () => {
    const wallet = await h.wallet("1.00");
    const request = h.request(wallet, { money: brl("5.00") });
    const first = await h.send(request);
    const replay = await h.send(request);
    expect(replay).toEqual({ transaction: first.transaction, idempotentReplay: true });
  });

  test("the same key with a different payload is a conflict, never a replay", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet, { money: brl("10.00") });
    await h.send(request);

    expect(h.send({ ...request, money: brl("11.00") })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await submittedCount(wallet.walletId)).toBe(1);
  });

  test("the same provider transaction under another key is a conflict", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet);
    await h.send(request);
    expect(h.send(request, { idempotencyKey: `other-${randomUUID()}` })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("the payload hash ignores transport metadata: correlation id and causation do not matter", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet);
    await h.send(request, { correlationId: "first" });
    const replay = await h.send(request, { correlationId: "second", causationId: "msg-x" });
    expect(replay.idempotentReplay).toBe(true);
  });

  test("an invalid request is refused before anything is persisted", async () => {
    const wallet = await h.wallet("100.00");
    expect(h.send(h.request(wallet, { money: brl("10") }))).rejects.toBeInstanceOf(InvalidMoneyError);
    expect(h.send(h.request(wallet, { kind: "OPENING" }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    expect(h.send(h.request(wallet, { kind: "REFUND" }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    expect(await submittedCount(wallet.walletId)).toBe(0);
  });
});

describe("inbox", () => {
  test("a redelivered message is answered from the stored result without a second effect", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet, { money: brl("15.00") });
    const inbox = { consumerName: "wager-consumer", messageId: `msg-${randomUUID()}` };

    const first = await h.send(request, { inbox, causationId: inbox.messageId });
    const redelivery = await h.send(request, { inbox, causationId: inbox.messageId });

    expect(first.idempotentReplay).toBe(false);
    expect(redelivery.idempotentReplay).toBe(true);
    expect(redelivery.transaction.transactionId).toBe(first.transaction.transactionId);
    const [inboxRow] = await p.sql`
      select processed_at is not null as processed from inbox_messages
      where consumer_name = ${inbox.consumerName} and message_id = ${inbox.messageId}`;
    expect(inboxRow.processed).toBe(true);
    const [event] = await p.sql`
      select payload->>'causationId' as causation from outbox_messages where aggregate_id = ${first.transaction.transactionId}`;
    expect(event.causation).toBe(inbox.messageId);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "85.00");
  });
});
