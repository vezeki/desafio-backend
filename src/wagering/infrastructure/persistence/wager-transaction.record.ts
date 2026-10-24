import { EntitySchema } from "@mikro-orm/core";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceAfterAmount?: string | null;
  referenceAttempts!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string", columnType: "char(64)" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    balanceAfterAmount: { type: "decimal", precision: 20, scale: 2, nullable: true },
    referenceAttempts: { type: "integer" },
    nextRetryAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});
