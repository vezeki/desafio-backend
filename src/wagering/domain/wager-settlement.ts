import { LedgerDirection } from "../../wallet/domain/ledger-direction.ts";
import type { Wallet } from "../../wallet/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry.ts";
import { FailureCode } from "./failure-code.ts";
import { ReferenceRetryPolicy } from "./reference-retry-policy.ts";
import type { ReferenceEvaluation, WagerTransaction } from "./wager-transaction.ts";

export interface SettlementInput {
  transaction: WagerTransaction;
  /** The target wallet, already locked by the caller; undefined when it does not exist. */
  wallet: Wallet | undefined;
  /** Result of `transaction.evaluateReference(...)`, NOT_APPLICABLE when there is no reference. */
  reference: ReferenceEvaluation;
  ledgerEntryId: string;
  now: Date;
}

export type Settlement =
  | { outcome: "PROCESSED"; entry?: WalletLedgerEntry }
  | { outcome: "REJECTED" }
  | { outcome: "PENDING_REFERENCE" };

/**
 * Applies a wager transaction to its wallet: decides between processing, rejecting and waiting for the reference,
 * and moves the balance when it applies. Mutates the transaction and the wallet; persisting them is up to the caller.
 */
export class WagerSettlement {
  constructor(private readonly referenceRetry = new ReferenceRetryPolicy()) {}

  settle({ transaction, wallet, reference, ledgerEntryId, now }: SettlementInput): Settlement {
    // No balance is recorded on these rejections: it would be another player's, or in another currency.
    if (!wallet) return reject(transaction, FailureCode.WalletNotFound, now);
    if (wallet.id !== transaction.walletId) {
      throw new Error(`Wallet ${wallet.id} given to settle a transaction of wallet ${transaction.walletId}`);
    }
    if (wallet.playerId !== transaction.playerId) return reject(transaction, FailureCode.WalletPlayerMismatch, now);
    if (wallet.currency !== transaction.money.currency) return reject(transaction, FailureCode.CurrencyMismatch, now);

    switch (reference.outcome) {
      case "MISSING":
      case "WAITING":
        return this.waitForReference(transaction, reference.outcome, wallet, now);
      case "INVALID":
        return reject(transaction, reference.failureCode, now, wallet);
    }
    const referenced = reference.outcome === "USABLE" ? reference.reference : undefined;

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(referenced?.id, now, wallet.balance);
      return { outcome: "PROCESSED" };
    }

    const direction = transaction.ledgerDirectionFor(referenced);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      // A reversal without funds is an operational problem, not a player without balance: distinct code.
      const code = transaction.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return reject(transaction, code, now, wallet);
    }

    const movement = { entryId: ledgerEntryId, transactionId: transaction.id, money: transaction.money, at: now };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    transaction.markProcessed(referenced?.id, now, wallet.balance);
    return { outcome: "PROCESSED", entry };
  }

  private waitForReference(
    transaction: WagerTransaction,
    outcome: "MISSING" | "WAITING",
    wallet: Wallet,
    now: Date,
  ): Settlement {
    const attempts = transaction.referenceAttempts + 1;
    if (this.referenceRetry.isExhausted(attempts)) {
      const code = outcome === "MISSING" ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
      return reject(transaction, code, now, wallet);
    }
    transaction.markPendingReference(this.referenceRetry.nextRetryAt(attempts, now));
    return { outcome: "PENDING_REFERENCE" };
  }
}

function reject(transaction: WagerTransaction, code: FailureCode, now: Date, wallet?: Wallet): Settlement {
  transaction.reject(code, now, wallet?.balance);
  return { outcome: "REJECTED" };
}
