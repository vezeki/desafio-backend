import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/wagering/domain/failure-code.ts";
import { createTestPersistence, type TestPersistence } from "../support/orm.ts";
import { expectBalanceMatchesLedger, wageringHarness } from "../support/wagering.ts";

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

async function debitEntries(walletId: string): Promise<number> {
  const [row] = await p.sql`
    select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row.count;
}

describe("concurrency on the same wallet", () => {
  test("mandatory scenario: 100.00 and two simultaneous 80.00 bets", async () => {
    const wallet = await h.wallet("100.00");

    const results = await Promise.all([
      h.send(h.request(wallet, { money: brl("80.00") })),
      h.send(h.request(wallet, { money: brl("80.00") })),
    ]);

    const statuses = results.map((result) => result.transaction.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((result) => result.transaction.status === "REJECTED")?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await debitEntries(wallet.walletId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "20.00");
  });

  test("the same bet sent 50 times in parallel debits once", async () => {
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet, { money: brl("10.00") });

    const results = await Promise.all(Array.from({ length: 50 }, () => h.send(request)));

    expect(new Set(results.map((result) => result.transaction.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.transaction.balance?.amount === "90.00")).toBe(true);
    expect(await debitEntries(wallet.walletId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "90.00");
  });

  test("a hot wallet never goes negative: 30 bets of 10.00 on 100.00", async () => {
    const wallet = await h.wallet("100.00");

    const results = await Promise.all(Array.from({ length: 30 }, () => h.send(h.request(wallet, { money: brl("10.00") }))));

    expect(results.filter((result) => result.transaction.status === "PROCESSED")).toHaveLength(10);
    expect(results.filter((result) => result.transaction.failureCode === FailureCode.InsufficientFunds)).toHaveLength(20);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "0.00");
  });

  test("parallel reversals of the same BET credit it once", async () => {
    const wallet = await h.wallet("100.00");
    const bet = await h.send(h.request(wallet, { money: brl("40.00") }));

    const results = await Promise.all(
      ["REFUND", "REFUND", "ROLLBACK", "REFUND", "ROLLBACK"].map((kind) =>
        h.send(h.request(wallet, { kind, money: brl("40.00"), referenceExternalTransactionId: bet.transaction.externalTransactionId })),
      ),
    );

    expect(results.filter((result) => result.transaction.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((result) => result.transaction.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(4);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "100.00");
  });

  test("the same request for an unknown wallet in parallel is registered once", async () => {
    const request = h.request({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID() });

    const results = await Promise.all(Array.from({ length: 10 }, () => h.send(request)));

    expect(new Set(results.map((result) => result.transaction.transactionId)).size).toBe(1);
    expect(results.every((result) => result.transaction.failureCode === FailureCode.WalletNotFound)).toBe(true);
  });
});

describe("concurrency across wallets", () => {
  test("distinct wallets are processed in parallel and each stays consistent", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => h.wallet("50.00")));

    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 6 }, () => h.send(h.request(wallet, { money: brl("10.00") })))),
    );
    const elapsed = performance.now() - started;

    expect(results.filter((result) => result.transaction.status === "PROCESSED")).toHaveLength(50);
    for (const wallet of wallets) await expectBalanceMatchesLedger(p.sql, wallet.walletId, "0.00");

    // One wallet lock does not block the others: 60 requests finish well within a serialized budget.
    expect(elapsed).toBeLessThan(10_000);
  });

  test("while one wallet is locked, another wallet is still processed", async () => {
    const [locked, free] = await Promise.all([h.wallet("10.00"), h.wallet("10.00")]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (acquired = resolve));
    const holder = p.unitOfWork.run(async (ctx) => {
      await ctx.wallets.findByIdForUpdate(locked.walletId);
      acquired();
      await held;
    });
    await lockAcquired;

    const result = await h.send(h.request(free, { money: brl("1.00") }));
    expect(result.transaction.status).toBe("PROCESSED");

    release();
    await holder;
  });
});
