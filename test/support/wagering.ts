import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import type { SQL } from "bun";
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
  type WagerRequest,
} from "../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { OpenWalletUseCase } from "../../src/wallet/application/open-wallet.use-case.ts";
import type { TestPersistence } from "./orm.ts";

export interface WalletUnderTest {
  walletId: string;
  playerId: string;
}

export function wageringHarness(p: TestPersistence) {
  const openWallet = new OpenWalletUseCase(p.unitOfWork, p.ids, p.clock);
  const submit = new SubmitWagerTransactionUseCase(p.unitOfWork, p.ids, p.clock);

  return {
    submit,

    async wallet(balance: string, currency = "BRL"): Promise<WalletUnderTest> {
      const view = await openWallet.execute({ playerId: randomUUID(), initialBalance: { amount: balance, currency }, correlationId: "test" });
      return { walletId: view.id, playerId: view.playerId };
    },

    /** A request with unique ids; the idempotency key follows the recommended `{providerId}:{externalTransactionId}`. */
    request(target: WalletUnderTest, overrides: Partial<WagerRequest> = {}): WagerRequest {
      return {
        providerId: "provider-a",
        externalTransactionId: `ext-${randomUUID()}`,
        playerId: target.playerId,
        walletId: target.walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        ...overrides,
      };
    },

    send(request: WagerRequest, extra: Partial<SubmitWagerTransactionCommand> = {}) {
      return submit.execute({
        idempotencyKey: `${request.providerId}:${request.externalTransactionId}`,
        request,
        correlationId: "test",
        ...extra,
      });
    },
  };
}

/** The invariant every test ends with: the stored balance equals the balance rebuilt from the ledger. */
export async function expectBalanceMatchesLedger(sql: SQL, walletId: string, expected?: string): Promise<void> {
  const [row] = await sql`
    select w.balance_amount as stored,
           (select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20, 2)::text
              from wallet_ledger_entries where wallet_id = w.id) as rebuilt
    from wallets w where w.id = ${walletId}`;
  expect(row.stored).toBe(row.rebuilt);
  if (expected !== undefined) expect(row.stored).toBe(expected);
}
