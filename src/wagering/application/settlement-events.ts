import { OutboxMessage } from "../../messaging/domain/outbox-message.ts";
import type { IdGenerator } from "../../shared/application/id-generator.ts";
import type { EventContext } from "../../shared/domain/integration-event.ts";
import { WalletBalanceChanged } from "../../wallet/domain/events/wallet-balance-changed.ts";
import type { Wallet } from "../../wallet/domain/wallet.ts";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/events/wager-transaction-events.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import type { Settlement } from "../domain/wager-settlement.ts";

export interface EventOrigin {
  correlationId: string;
  /** Id of the message or request that caused the events, when known. */
  causationId?: string;
  occurredAt: Date;
}

/** Outbox messages for the outcome of a settlement; written in the same SQL transaction. */
export function settlementEvents(
  settlement: Settlement,
  transaction: WagerTransaction,
  wallet: Wallet | undefined,
  origin: EventOrigin,
  ids: IdGenerator,
): OutboxMessage[] {
  const context = (): EventContext => ({
    eventId: ids.next(),
    correlationId: origin.correlationId,
    occurredAt: origin.occurredAt,
    ...(origin.causationId ? { causationId: origin.causationId } : {}),
  });

  switch (settlement.outcome) {
    case "PROCESSED": {
      const events = [OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context()))];
      if (settlement.entry && wallet) {
        events.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, settlement.entry, context())));
      }
      return events;
    }
    case "REJECTED":
      return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context()))];
    case "PENDING_REFERENCE":
      return [OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context()))];
  }
}
