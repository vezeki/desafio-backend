import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProcessDuePendingReferencesUseCase } from "../../../src/wagering/application/process-due-pending-references.use-case.ts";
import { SubmitWagerTransactionUseCase } from "../../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction-status.ts";
import { ReferenceRetryPolicy } from "../../../src/wagering/domain/reference-retry-policy.ts";
import { WagerSettlement } from "../../../src/wagering/domain/wager-settlement.ts";
import { OpenWalletUseCase } from "../../../src/wallet/application/open-wallet.use-case.ts";
import { AdjustableClock } from "../../support/clock.ts";
import { createTestPersistence, type TestPersistence } from "../../support/orm.ts";
import { expectBalanceMatchesLedger, type WalletUnderTest } from "../../support/wagering.ts";

/** First retry is scheduled 2s after the submit (policy default, attempt 1). */
const FIRST_RETRY_MS = 2_000;

let p: TestPersistence;
/** Each test gets its own calendar day so advancing one clock cannot make another test's rows due. */
let day = 0;

beforeAll(async () => {
  p = await createTestPersistence();
});

afterAll(async () => {
  await p.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function harness(settlement?: WagerSettlement) {
  // The suite does not truncate: park leftovers so this clock cannot claim another test's rows.
  await p.sql`update wager_transactions set next_retry_at = '2999-01-01T00:00:00Z' where status = 'PENDING_REFERENCE'`;
  const clock = new AdjustableClock(new Date(Date.UTC(2100, 0, ++day)));
  const submit = new SubmitWagerTransactionUseCase(p.unitOfWork, p.ids, clock, settlement);
  const worker = new ProcessDuePendingReferencesUseCase(p.unitOfWork, p.ids, clock, settlement);
  const openWallet = new OpenWalletUseCase(p.unitOfWork, p.ids, clock);
  return { clock, submit, worker, openWallet };
}

async function wallet(h: Awaited<ReturnType<typeof harness>>, balance: string): Promise<WalletUnderTest> {
  const view = await h.openWallet.execute({
    playerId: p.ids.next(),
    initialBalance: brl(balance),
    correlationId: "test",
  });
  return { walletId: view.id, playerId: view.playerId };
}

function request(target: WalletUnderTest, overrides: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: `ext-${p.ids.next()}`,
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: brl("25.00"),
    ...overrides,
  };
}

function send(h: Awaited<ReturnType<typeof harness>>, body: ReturnType<typeof request>) {
  return h.submit.execute({
    idempotencyKey: `${body.providerId}:${body.externalTransactionId}`,
    request: body,
    correlationId: "test",
  });
}

async function eventsOf(transactionId: string) {
  const rows = await p.sql`
    select event_type from outbox_messages
    where payload->'data'->>'transactionId' = ${transactionId} order by occurred_at, event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

describe("ProcessDuePendingReferencesUseCase", () => {
  test("does not claim a pending whose next retry is still in the future", async () => {
    const h = await harness();
    const target = await wallet(h, "100.00");
    const refund = await send(h, request(target, { kind: "REFUND", referenceExternalTransactionId: `bet-${p.ids.next()}` }));

    expect(refund.transaction.status).toBe("PENDING_REFERENCE");
    expect(await h.worker.execute(10)).toEqual({ claimed: 0, processed: 0, rejected: 0, stillWaiting: 0 });
    const stored = await p.unitOfWork.read((ctx) => ctx.transactions.findById(refund.transaction.transactionId));
    expect(stored?.referenceAttempts).toBe(1);
  });

  test("when the BET has arrived, the due REFUND is applied on the next tick", async () => {
    const h = await harness();
    const target = await wallet(h, "100.00");
    const betId = `bet-${p.ids.next()}`;
    const refund = await send(h, request(target, { kind: "REFUND", money: brl("25.00"), referenceExternalTransactionId: betId }));
    const bet = await send(h, request(target, { externalTransactionId: betId, money: brl("25.00") }));
    expect(bet.transaction.status).toBe("PROCESSED");

    h.clock.advance(FIRST_RETRY_MS);
    expect(await h.worker.execute(10)).toEqual({ claimed: 1, processed: 1, rejected: 0, stillWaiting: 0 });

    const stored = await p.unitOfWork.read((ctx) => ctx.transactions.findById(refund.transaction.transactionId));
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.referenceTransactionId).toBe(bet.transaction.transactionId);
    expect(await eventsOf(refund.transaction.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    await expectBalanceMatchesLedger(p.sql, target.walletId, "100.00");
  });

  test("when the BET is still missing, the due row is rescheduled with another attempt", async () => {
    const h = await harness();
    const target = await wallet(h, "100.00");
    const refund = await send(h, request(target, { kind: "REFUND", referenceExternalTransactionId: `bet-${p.ids.next()}` }));

    h.clock.advance(FIRST_RETRY_MS);
    expect(await h.worker.execute(10)).toEqual({ claimed: 1, processed: 0, rejected: 0, stillWaiting: 1 });

    const stored = await p.unitOfWork.read((ctx) => ctx.transactions.findById(refund.transaction.transactionId));
    expect(stored?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(stored?.referenceAttempts).toBe(2);
    expect(stored?.nextRetryAt?.getTime()).toBe(h.clock.now().getTime() + 4_000);
    await expectBalanceMatchesLedger(p.sql, target.walletId, "100.00");
  });

  test("after the last attempt a missing reference is rejected with REFERENCE_NOT_FOUND", async () => {
    const short = new WagerSettlement(new ReferenceRetryPolicy({ maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 60_000 }));
    const h = await harness(short);
    const target = await wallet(h, "100.00");
    const refund = await send(h, request(target, { kind: "REFUND", referenceExternalTransactionId: `never-${p.ids.next()}` }));

    h.clock.advance(1_000);
    expect(await h.worker.execute(10)).toEqual({ claimed: 1, processed: 0, rejected: 1, stillWaiting: 0 });

    const stored = await p.unitOfWork.read((ctx) => ctx.transactions.findById(refund.transaction.transactionId));
    expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await eventsOf(refund.transaction.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    await expectBalanceMatchesLedger(p.sql, target.walletId, "100.00");
  });

  test("a reference that arrived REJECTED becomes REFERENCE_NOT_PROCESSED", async () => {
    const h = await harness();
    const target = await wallet(h, "1.00");
    const betId = `bet-${p.ids.next()}`;
    const refund = await send(h, request(target, { kind: "REFUND", money: brl("25.00"), referenceExternalTransactionId: betId }));
    const bet = await send(h, request(target, { externalTransactionId: betId, money: brl("25.00") }));
    expect(bet.transaction.failureCode).toBe(FailureCode.InsufficientFunds);

    h.clock.advance(FIRST_RETRY_MS);
    expect(await h.worker.execute(10)).toEqual({ claimed: 1, processed: 0, rejected: 1, stillWaiting: 0 });

    const stored = await p.unitOfWork.read((ctx) => ctx.transactions.findById(refund.transaction.transactionId));
    expect(stored?.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    await expectBalanceMatchesLedger(p.sql, target.walletId, "1.00");
  });

  test("two workers claiming at once process distinct due rows and skip a locked one", async () => {
    const h = await harness();
    const [a, b] = await Promise.all([wallet(h, "100.00"), wallet(h, "100.00")]);
    await send(h, request(a, { kind: "REFUND", referenceExternalTransactionId: `bet-${p.ids.next()}` }));
    await send(h, request(b, { kind: "REFUND", referenceExternalTransactionId: `bet-${p.ids.next()}` }));
    h.clock.advance(FIRST_RETRY_MS);

    const other = await createTestPersistence();
    const otherWorker = new ProcessDuePendingReferencesUseCase(other.unitOfWork, other.ids, h.clock);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));

    const holder = p.unitOfWork.run(async (ctx) => {
      const claimed = await ctx.transactions.claimDuePendingReferences(h.clock.now(), 1);
      expect(claimed).toHaveLength(1);
      locked();
      await held;
      return claimed[0]!.id;
    });
    try {
      await lockAcquired;

      const tick = await otherWorker.execute(10);
      expect(tick.claimed).toBe(1);
      expect(tick.stillWaiting).toBe(1);
    } finally {
      release();
      await holder;
      await other.close();
    }

    const leftover = await h.worker.execute(10);
    expect(leftover.claimed).toBe(1);
    expect(leftover.stillWaiting).toBe(1);
  });
});
