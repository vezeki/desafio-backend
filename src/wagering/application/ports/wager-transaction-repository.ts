import type { WagerTransaction } from "../../domain/wager-transaction.ts";
import type { WagerTransactionKind } from "../../domain/wager-transaction-kind.ts";

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Kinds of PROCESSED transactions that point to `referenceTransactionId`. */
  findProcessedDependentKinds(referenceTransactionId: string): Promise<WagerTransactionKind[]>;
  /**
   * Due `PENDING_REFERENCE` rows, locked with `FOR UPDATE SKIP LOCKED`.
   * Must run inside `UnitOfWork.run`: the lock lives only for that SQL transaction.
   */
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  add(transaction: WagerTransaction): void;
  /** Persists state transitions of a transaction loaded or added in this transaction. */
  save(transaction: WagerTransaction): void;
}
