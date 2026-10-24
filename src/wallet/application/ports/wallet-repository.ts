import type { Money } from "../../../shared/domain/money.ts";
import type { Wallet } from "../../domain/wallet.ts";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.ts";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: blocks other writers of this wallet until the transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Persists balance/version changes of a wallet loaded in this transaction. */
  save(wallet: Wallet): void;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Sequence of the last returned entry, when more entries may exist. */
  nextAfterSequence?: number;
}

export interface LedgerTotals {
  balance: Money;
  entries: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  /** Entries ordered by sequence, strictly after `afterSequence`. */
  listByWallet(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerPage>;
  /** Signed sum of all entries, computed by the database. */
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}
