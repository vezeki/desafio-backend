import { IntegrationEvent, type EventContext } from "../../../shared/domain/integration-event.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import { FAILURE_CATEGORY, type FailureCategory, type FailureCode } from "../failure-code.ts";
import type { WagerTransaction } from "../wager-transaction.ts";
import type { WagerTransactionKind } from "../wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../wager-transaction-status.ts";

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  failureCategory: FailureCategory;
  balanceAfter?: MoneyProps;
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextRetryAt: string;
}

function baseData(transaction: WagerTransaction): WagerTransactionEventData {
  const data: WagerTransactionEventData = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
  };
  if (transaction.referenceExternalTransactionId !== undefined) {
    data.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  }
  return data;
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus, eventType: string): void {
  if (transaction.status !== expected) {
    throw new Error(`${eventType} requires status ${expected}, transaction ${transaction.id} is ${transaction.status}`);
  }
}

/** Any applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, "WagerTransactionProcessed");
    const data: WagerTransactionProcessedData = {
      ...baseData(transaction),
      balanceAfter: transaction.balanceAfter!.toJSON(),
      processedAt: transaction.processedAt!.toISOString(),
    };
    if (transaction.referenceTransactionId !== undefined) data.referenceTransactionId = transaction.referenceTransactionId;
    return new WagerTransactionProcessed({ ...ctx, aggregateId: transaction.id, data });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, "WagerTransactionRejected");
    const failureCode = transaction.failureCode!;
    const data: WagerTransactionRejectedData = {
      ...baseData(transaction),
      failureCode,
      failureCategory: FAILURE_CATEGORY[failureCode],
      rejectedAt: transaction.processedAt!.toISOString(),
    };
    if (transaction.balanceAfter !== undefined) data.balanceAfter = transaction.balanceAfter.toJSON();
    return new WagerTransactionRejected({ ...ctx, aggregateId: transaction.id, data });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference, "WagerTransactionPendingReference");
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
        attempts: transaction.referenceAttempts,
        nextRetryAt: transaction.nextRetryAt!.toISOString(),
      },
    });
  }
}
