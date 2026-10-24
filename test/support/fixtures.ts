import type { IdGenerator } from "../../src/shared/application/id-generator.ts";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work.ts";
import { Money } from "../../src/shared/domain/money.ts";
import { FailureCode } from "../../src/wagering/domain/failure-code.ts";
import { WagerTransaction } from "../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction-kind.ts";
import type { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction-status.ts";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export interface BetTarget {
  walletId: string;
  playerId: string;
}

/**
 * Minimal debit flow straight on the repositories, the same shape the submit use case will have.
 * `lock: false` deliberately skips FOR UPDATE to exercise the database guards.
 */
export function placeBet(
  unitOfWork: UnitOfWork,
  ids: IdGenerator,
  target: BetTarget,
  amount: string,
  options: { lock?: boolean } = {},
): Promise<WagerTransactionStatus> {
  return unitOfWork.run(async (ctx) => {
    const wallet =
      options.lock === false ? await ctx.wallets.findById(target.walletId) : await ctx.wallets.findByIdForUpdate(target.walletId);
    if (!wallet) throw new Error(`wallet ${target.walletId} not found`);

    const externalId = ids.next();
    const transaction = WagerTransaction.create({
      id: ids.next(),
      providerId: "provider-a",
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      walletId: target.walletId,
      playerId: target.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      createdAt: new Date(),
    });
    const now = new Date();

    if (!wallet.canDebit(transaction.money)) {
      transaction.reject(FailureCode.InsufficientFunds, now, wallet.balance);
      ctx.transactions.add(transaction);
      return transaction.status;
    }

    const entry = wallet.debit({ entryId: ids.next(), transactionId: transaction.id, money: transaction.money, at: now });
    transaction.markProcessed(undefined, now, wallet.balance);
    ctx.wallets.save(wallet);
    ctx.transactions.add(transaction);
    ctx.ledger.add(entry);
    return transaction.status;
  });
}
