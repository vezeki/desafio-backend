import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InboxMessage } from "../../../src/messaging/domain/inbox-message.ts";
import { TransientInfrastructureError } from "../../../src/shared/application/errors.ts";
import { Money } from "../../../src/shared/domain/money.ts";
import { FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction-status.ts";
import { OpenWalletUseCase } from "../../../src/wallet/application/open-wallet.use-case.ts";
import { createTestPersistence, type TestPersistence } from "../../support/orm.ts";

let p: TestPersistence;
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  p = await createTestPersistence();
  openWallet = new OpenWalletUseCase(p.unitOfWork, p.ids, p.clock);
});

afterAll(async () => {
  await p.close();
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

async function newWallet(balance: string) {
  return openWallet.execute({ playerId: p.ids.next(), initialBalance: { amount: balance, currency: "BRL" }, correlationId: "test" });
}

function bet(walletId: string, playerId: string, amount: string): WagerTransaction {
  const externalId = p.ids.next();
  return WagerTransaction.create({
    id: p.ids.next(),
    providerId: "provider-a",
    externalTransactionId: externalId,
    idempotencyKey: `key-${externalId}`,
    walletId,
    playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    createdAt: new Date(),
  });
}

/** Minimal debit flow, the same shape the submit use case will have. */
function placeBet(walletId: string, playerId: string, amount: string, lock = true) {
  return p.unitOfWork.run(async (ctx) => {
    const wallet = lock ? await ctx.wallets.findByIdForUpdate(walletId) : await ctx.wallets.findById(walletId);
    if (!wallet) throw new Error("wallet not found");
    const transaction = bet(walletId, playerId, amount);
    const now = new Date();

    if (!wallet.canDebit(transaction.money)) {
      transaction.reject(FailureCode.InsufficientFunds, now, wallet.balance);
      ctx.transactions.add(transaction);
      return transaction.status;
    }

    const entry = wallet.debit({ entryId: p.ids.next(), transactionId: transaction.id, money: transaction.money, at: now });
    transaction.markProcessed(undefined, now, wallet.balance);
    ctx.wallets.save(wallet);
    ctx.transactions.add(transaction);
    ctx.ledger.add(entry);
    return transaction.status;
  });
}

describe("MikroOrmUnitOfWork", () => {
  test("money round-trips as exact decimal strings, including the largest supported value", async () => {
    const view = await newWallet("999999999999999999.99");
    const wallet = await p.unitOfWork.read((ctx) => ctx.wallets.findById(view.id));
    expect(wallet?.balance.toJSON()).toEqual({ amount: "999999999999999999.99", currency: "BRL" });
  });

  test("an error inside the work rolls back every write", async () => {
    const playerId = p.ids.next();
    const failure = new Error("boom after writing");

    const attempt = openWalletThenFail(playerId, failure);
    expect(attempt).rejects.toBe(failure);
    await attempt.catch(() => undefined);

    const [counts] = await p.sql`
      select (select count(*)::int from wallets where player_id = ${playerId}) as wallets,
             (select count(*)::int from wager_transactions where player_id = ${playerId}) as transactions`;
    expect(counts).toEqual({ wallets: 0, transactions: 0 });
  });

  test("debit updates balance, version and ledger in one commit", async () => {
    const view = await newWallet("100.00");
    expect(await placeBet(view.id, view.playerId, "30.00")).toBe(WagerTransactionStatus.Processed);

    const wallet = await p.unitOfWork.read((ctx) => ctx.wallets.findById(view.id));
    expect(wallet?.balance.amount).toBe("70.00");
    expect(wallet?.version).toBe(2);

    const totals = await p.unitOfWork.read((ctx) => ctx.ledger.totals(view.id, "BRL"));
    expect(totals.balance.amount).toBe("70.00");
    expect(totals.entries).toBe(2);
  });

  test("FOR UPDATE serializes concurrent debits: 100.00 with two parallel 80.00 bets", async () => {
    const view = await newWallet("100.00");

    const statuses = await Promise.all([
      placeBet(view.id, view.playerId, "80.00"),
      placeBet(view.id, view.playerId, "80.00"),
    ]);

    expect(statuses.sort()).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const [row] = await p.sql`select balance_amount, version from wallets where id = ${view.id}`;
    expect(row).toEqual({ balance_amount: "20.00", version: 2 });
  });

  test("without the lock, the version guard refuses the lost update instead of corrupting the balance", async () => {
    const view = await newWallet("100.00");

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => placeBet(view.id, view.playerId, "10.00", false)),
    );

    const processed = results.filter((result) => result.status === "fulfilled").length;
    const [row] = await p.sql`select balance_amount, version from wallets where id = ${view.id}`;
    const totals = await p.unitOfWork.read((ctx) => ctx.ledger.totals(view.id, "BRL"));
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(row.version).toBe(1 + processed);
    expect(row.balance_amount).toBe(brl("100.00").subtract(brl(`${processed * 10}.00`)).amount);
    expect(totals.balance.amount).toBe(row.balance_amount);
  });

  test("a held lock beyond lock_timeout surfaces as a transient error", async () => {
    const view = await newWallet("50.00");
    const other = await createTestPersistence({ lockTimeoutMs: 100, maxAttempts: 2 });
    const impatient = other.unitOfWork;

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));

    const holder = p.unitOfWork.run(async (ctx) => {
      await ctx.wallets.findByIdForUpdate(view.id);
      locked();
      await held;
    });
    await lockAcquired;

    const waiting = impatient.run((ctx) => ctx.wallets.findByIdForUpdate(view.id));
    expect(waiting).rejects.toBeInstanceOf(TransientInfrastructureError);
    await waiting.catch(() => undefined);

    release();
    await holder;
    await other.close();
  });

  test("ledger pages are ordered by sequence with a continuation point", async () => {
    const view = await newWallet("100.00");
    for (const amount of ["1.00", "2.00", "3.00"]) await placeBet(view.id, view.playerId, amount);

    const first = await p.unitOfWork.read((ctx) => ctx.ledger.listByWallet(view.id, { limit: 3 }));
    expect(first.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(first.nextAfterSequence).toBe(3);

    const second = await p.unitOfWork.read((ctx) =>
      ctx.ledger.listByWallet(view.id, { afterSequence: first.nextAfterSequence, limit: 3 }),
    );
    expect(second.entries.map((entry) => [entry.sequence, entry.balanceAfter.amount])).toEqual([[4, "94.00"]]);
    expect(second.nextAfterSequence).toBeUndefined();
  });

  test("inbox records a message once, even when two transactions race for it", async () => {
    const messageId = p.ids.next();
    const receive = () =>
      p.unitOfWork.run((ctx) =>
        ctx.inbox.tryRecord(
          InboxMessage.receive({ consumerName: "test-consumer", messageId, payloadHash: "a".repeat(64), receivedAt: new Date() }),
        ),
      );

    const results = await Promise.all([receive(), receive(), receive()]);
    expect(results.sort()).toEqual([false, false, true]);
    expect(await receive()).toBe(false);

    const stored = await p.unitOfWork.read((ctx) => ctx.inbox.find("test-consumer", messageId));
    expect(stored?.payloadHash).toBe("a".repeat(64));
  });
});

function openWalletThenFail(playerId: string, failure: Error) {
  const failingUnitOfWork = {
    run: <T>(work: Parameters<typeof p.unitOfWork.run<T>>[0]) =>
      p.unitOfWork.run(async (ctx) => {
        await work(ctx);
        // The query auto-flushes: the rows really reach the database before the rollback.
        expect(await ctx.wallets.findByPlayerAndCurrency(playerId, "BRL")).toBeDefined();
        const [visible] = await p.sql`select count(*)::int as count from wallets where player_id = ${playerId}`;
        expect(visible.count).toBe(0);
        throw failure;
      }),
    read: p.unitOfWork.read.bind(p.unitOfWork),
  };
  return new OpenWalletUseCase(failingUnitOfWork, p.ids, p.clock).execute({
    playerId,
    initialBalance: { amount: "10.00", currency: "BRL" },
    correlationId: "rollback",
  });
}
