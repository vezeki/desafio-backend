import { EntitySchema } from "@mikro-orm/core";

/** Row of `wallets`. Money columns are `numeric(20,2)` and arrive as strings — never as number. */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", columnType: "char(3)" },
    balanceAmount: { type: "decimal", precision: 20, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    updatedAt: { type: "datetime", columnType: "timestamptz" },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  sequence!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", columnType: "char(3)" },
    balanceBeforeAmount: { type: "decimal", precision: 20, scale: 2 },
    balanceAfterAmount: { type: "decimal", precision: 20, scale: 2 },
    sequence: { type: "integer" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
  },
});
