import type { IdGenerator } from "../../shared/application/id-generator.ts";
import type { TransactionContext } from "../../shared/application/unit-of-work.ts";
import type { Wallet } from "../../wallet/domain/wallet.ts";
import type { ReferenceEvaluation, WagerTransaction } from "../domain/wager-transaction.ts";
import type { Settlement } from "../domain/wager-settlement.ts";
import { settlementEvents, type EventOrigin } from "./settlement-events.ts";

/** Resolves the referenced transaction the same way on submit and on a pending-reference retry. */
export async function resolveReference(ctx: TransactionContext, transaction: WagerTransaction): Promise<ReferenceEvaluation> {
  if (!transaction.referenceExternalTransactionId) return transaction.evaluateReference(undefined);
  const reference = await ctx.transactions.findByProviderExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId,
  );
  const dependents = reference ? await ctx.transactions.findProcessedDependentKinds(reference.id) : [];
  return transaction.evaluateReference(reference, dependents);
}

export function persistSettlement(
  ctx: TransactionContext,
  settlement: Settlement,
  transaction: WagerTransaction,
  wallet: Wallet | undefined,
  persist: "add" | "save",
  origin: EventOrigin,
  ids: IdGenerator,
): void {
  if (persist === "add") ctx.transactions.add(transaction);
  else ctx.transactions.save(transaction);
  if (settlement.outcome === "PROCESSED" && settlement.entry && wallet) {
    ctx.wallets.save(wallet);
    ctx.ledger.add(settlement.entry);
  }
  for (const message of settlementEvents(settlement, transaction, wallet, origin, ids)) {
    ctx.outbox.add(message);
  }
}
