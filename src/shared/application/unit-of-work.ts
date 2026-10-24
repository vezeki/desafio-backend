import type { InboxRepository, OutboxRepository } from "../../messaging/application/ports/messaging-repositories.ts";
import type { WagerTransactionRepository } from "../../wagering/application/ports/wager-transaction-repository.ts";
import type { LedgerRepository, WalletRepository } from "../../wallet/application/ports/wallet-repository.ts";

/** Repositories bound to one database transaction. */
export interface TransactionContext {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Runs `work` in a single SQL transaction: everything added or saved is committed together, or nothing is.
   * Transient conflicts (deadlock, serialization failure, lock timeout) are retried a bounded number of times,
   * so `work` must not have side effects outside the database.
   */
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
  /** Read-only access without an explicit transaction: each query may see a different committed state. */
  read<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
  /** Read-only transaction where every query sees the same snapshot, for reads that must agree with each other. */
  snapshot<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
