import type { MoneyProps } from "../../shared/domain/money.ts";
import { FAILURE_CATEGORY, type FailureCategory, type FailureCode } from "../domain/failure-code.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: FailureCode;
  failureCategory?: FailureCategory;
  /** Wallet balance observed when the transaction was decided; the same value on every replay. */
  balance?: MoneyProps;
  referenceAttempts?: number;
  nextRetryAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  const view: WagerTransactionView = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
  };
  if (transaction.referenceExternalTransactionId) view.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  if (transaction.referenceTransactionId) view.referenceTransactionId = transaction.referenceTransactionId;
  if (transaction.failureCode) {
    view.failureCode = transaction.failureCode;
    view.failureCategory = FAILURE_CATEGORY[transaction.failureCode];
  }
  if (transaction.balanceAfter) view.balance = transaction.balanceAfter.toJSON();
  if (transaction.referenceAttempts > 0) view.referenceAttempts = transaction.referenceAttempts;
  if (transaction.nextRetryAt) view.nextRetryAt = transaction.nextRetryAt.toISOString();
  if (transaction.processedAt) view.processedAt = transaction.processedAt.toISOString();
  return view;
}
