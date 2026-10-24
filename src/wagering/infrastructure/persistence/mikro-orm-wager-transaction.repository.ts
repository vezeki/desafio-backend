import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../shared/domain/money.ts";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository.ts";
import type { FailureCode } from "../../domain/failure-code.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import type { WagerTransactionKind } from "../../domain/wager-transaction-kind.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction-status.ts";
import { WagerTransactionRecord } from "./wager-transaction.record.ts";

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.fromSigned({ amount, currency: record.currency });
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    status: record.status as WagerTransactionStatus,
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    balanceAfter: record.balanceAfterAmount ? money(record.balanceAfterAmount) : undefined,
    referenceAttempts: record.referenceAttempts,
    nextRetryAt: orUndefined(record.nextRetryAt),
    createdAt: record.createdAt,
    processedAt: orUndefined(record.processedAt),
  });
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly tracked = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }));
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async findProcessedDependentKinds(referenceTransactionId: string): Promise<WagerTransactionKind[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { referenceTransactionId, status: WagerTransactionStatus.Processed },
      { fields: ["kind"] },
    );
    return records.map((record) => record.kind as WagerTransactionKind);
  }

  add(transaction: WagerTransaction): void {
    const record = new WagerTransactionRecord();
    record.id = transaction.id;
    record.providerId = transaction.providerId;
    record.externalTransactionId = transaction.externalTransactionId;
    record.idempotencyKey = transaction.idempotencyKey;
    record.payloadHash = transaction.payloadHash;
    record.walletId = transaction.walletId;
    record.playerId = transaction.playerId;
    record.roundId = transaction.roundId;
    record.gameId = transaction.gameId;
    record.kind = transaction.kind;
    record.amount = transaction.money.amount;
    record.currency = transaction.money.currency;
    record.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    record.createdAt = transaction.createdAt;
    this.copyMutableState(transaction, record);
    this.em.persist(record);
    this.tracked.set(transaction.id, record);
  }

  save(transaction: WagerTransaction): void {
    const record = this.tracked.get(transaction.id);
    if (!record) {
      throw new Error(`Transaction ${transaction.id} was not loaded in this transaction`);
    }
    this.copyMutableState(transaction, record);
  }

  private copyMutableState(transaction: WagerTransaction, record: WagerTransactionRecord): void {
    record.status = transaction.status;
    record.referenceTransactionId = transaction.referenceTransactionId ?? null;
    record.failureCode = transaction.failureCode ?? null;
    record.balanceAfterAmount = transaction.balanceAfter?.amount ?? null;
    record.referenceAttempts = transaction.referenceAttempts;
    record.nextRetryAt = transaction.nextRetryAt ?? null;
    record.processedAt = transaction.processedAt ?? null;
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) return undefined;
    this.tracked.set(record.id, record);
    return toWagerTransaction(record);
  }
}
