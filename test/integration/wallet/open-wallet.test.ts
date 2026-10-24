import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InvalidMoneyError } from "../../../src/shared/domain/domain-error.ts";
import { OpenWalletUseCase } from "../../../src/wallet/application/open-wallet.use-case.ts";
import { WalletAlreadyExistsError } from "../../../src/wallet/domain/wallet-errors.ts";
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

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function rowsFor(walletId: string) {
  const [wallet] = await p.sql`select balance_amount, version from wallets where id = ${walletId}`;
  const transactions = await p.sql`
    select kind, status, amount, provider_id, balance_after_amount from wager_transactions where wallet_id = ${walletId}`;
  const ledger = await p.sql`
    select direction, amount, balance_before_amount, balance_after_amount, sequence
    from wallet_ledger_entries where wallet_id = ${walletId}`;
  const outbox = await p.sql`select event_type, payload from outbox_messages where aggregate_id = ${walletId}`;
  return { wallet, transactions, ledger, outbox };
}

describe("OpenWalletUseCase", () => {
  test("a positive initial balance is justified by an OPENING transaction, a ledger credit and an event", async () => {
    const view = await openWallet.execute({ playerId: p.ids.next(), initialBalance: brl("1000.00"), correlationId: "c-1" });

    expect(view.balance).toEqual(brl("1000.00"));
    expect(view.version).toBe(1);

    const rows = await rowsFor(view.id);
    expect(rows.wallet).toEqual({ balance_amount: "1000.00", version: 1 });
    expect(rows.transactions).toEqual([
      { kind: "OPENING", status: "PROCESSED", amount: "1000.00", provider_id: "internal", balance_after_amount: "1000.00" },
    ]);
    expect(rows.ledger).toEqual([
      { direction: "CREDIT", amount: "1000.00", balance_before_amount: "0.00", balance_after_amount: "1000.00", sequence: 1 },
    ]);
    expect(rows.outbox).toHaveLength(1);
    expect(rows.outbox[0].event_type).toBe("WalletBalanceChanged");
    expect(rows.outbox[0].payload.correlationId).toBe("c-1");
    expect(rows.outbox[0].payload.data.balanceAfter).toEqual(brl("1000.00"));
  });

  test("a zero balance opens the wallet without transaction, ledger or event", async () => {
    const view = await openWallet.execute({ playerId: p.ids.next(), initialBalance: brl("0.00"), correlationId: "c-2" });

    const rows = await rowsFor(view.id);
    expect(rows.wallet).toEqual({ balance_amount: "0.00", version: 1 });
    expect(rows.transactions).toEqual([]);
    expect(rows.ledger).toEqual([]);
    expect(rows.outbox).toEqual([]);
  });

  test("a second wallet in the same currency is refused, another currency is allowed", async () => {
    const playerId = p.ids.next();
    await openWallet.execute({ playerId, initialBalance: brl("10.00"), correlationId: "c-3" });

    expect(openWallet.execute({ playerId, initialBalance: brl("5.00"), correlationId: "c-4" })).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    const usd = await openWallet.execute({ playerId, initialBalance: { amount: "5.00", currency: "USD" }, correlationId: "c-5" });
    expect(usd.balance.currency).toBe("USD");
  });

  test("concurrent opens for the same player create exactly one wallet", async () => {
    const playerId = p.ids.next();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        openWallet.execute({ playerId, initialBalance: brl("100.00"), correlationId: `race-${i}` }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const result of rejected) expect(result.reason).toBeInstanceOf(WalletAlreadyExistsError);

    const [counts] = await p.sql`
      select (select count(*)::int from wallets where player_id = ${playerId}) as wallets,
             (select count(*)::int from wager_transactions where player_id = ${playerId}) as transactions,
             (select count(*)::int from outbox_messages o join wallets w on w.id = o.aggregate_id
               where w.player_id = ${playerId}) as events`;
    expect(counts).toEqual({ wallets: 1, transactions: 1, events: 1 });
  });

  test("invalid money is rejected before touching the database", async () => {
    const playerId = p.ids.next();
    for (const amount of ["10", "10.5", "-1.00", "1e3"]) {
      expect(openWallet.execute({ playerId, initialBalance: brl(amount), correlationId: "c-6" })).rejects.toBeInstanceOf(
        InvalidMoneyError,
      );
    }
    const [row] = await p.sql`select count(*)::int as count from wallets where player_id = ${playerId}`;
    expect(row.count).toBe(0);
  });
});
