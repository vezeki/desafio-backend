import { InboxSchema, OutboxSchema } from "../../../messaging/infrastructure/persistence/messaging.records.ts";
import { WagerTransactionSchema } from "../../../wagering/infrastructure/persistence/wager-transaction.record.ts";
import { LedgerEntrySchema, WalletSchema } from "../../../wallet/infrastructure/persistence/wallet.records.ts";

export const ENTITY_SCHEMAS = [WalletSchema, LedgerEntrySchema, WagerTransactionSchema, InboxSchema, OutboxSchema];
