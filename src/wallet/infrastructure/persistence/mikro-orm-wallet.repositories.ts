import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../shared/domain/money.ts";
import type { LedgerPage, LedgerRepository, LedgerTotals, WalletRepository } from "../../application/ports/wallet-repository.ts";
import type { LedgerDirection } from "../../domain/ledger-direction.ts";
import { Wallet } from "../../domain/wallet.ts";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.ts";
import { LedgerEntryRecord, WalletRecord } from "./wallet.records.ts";

const money = (amount: string, currency: string) => Money.fromSigned({ amount, currency });

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balanceAmount, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBeforeAmount, record.currency),
    balanceAfter: money(record.balanceAfterAmount, record.currency),
    sequence: record.sequence,
    createdAt: record.createdAt,
  });
}

export class MikroOrmWalletRepository implements WalletRepository {
  /** Managed records of wallets loaded or added through this repository (one instance per transaction). */
  private readonly tracked = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }));
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // refresh: the identity map may hold a copy read before the lock was acquired.
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return this.track(record);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { playerId, currency }));
  }

  add(wallet: Wallet): void {
    const record = new WalletRecord();
    record.id = wallet.id;
    record.playerId = wallet.playerId;
    record.currency = wallet.currency;
    record.createdAt = wallet.createdAt;
    this.copyMutableState(wallet, record);
    this.em.persist(record);
    this.tracked.set(wallet.id, record);
  }

  save(wallet: Wallet): void {
    const record = this.tracked.get(wallet.id);
    if (!record) {
      throw new Error(`Wallet ${wallet.id} was not loaded in this transaction`);
    }
    this.copyMutableState(wallet, record);
  }

  private copyMutableState(wallet: Wallet, record: WalletRecord): void {
    record.balanceAmount = wallet.balance.amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  }

  private track(record: WalletRecord | null): Wallet | undefined {
    if (!record) return undefined;
    this.tracked.set(record.id, record);
    return toWallet(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    const record = new LedgerEntryRecord();
    record.id = entry.id;
    record.walletId = entry.walletId;
    record.transactionId = entry.transactionId;
    record.direction = entry.direction;
    record.amount = entry.money.amount;
    record.currency = entry.money.currency;
    record.balanceBeforeAmount = entry.balanceBefore.amount;
    record.balanceAfterAmount = entry.balanceAfter.amount;
    record.sequence = entry.sequence;
    record.createdAt = entry.createdAt;
    this.em.persist(record);
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(LedgerEntryRecord, { transactionId });
    return record ? toLedgerEntry(record) : undefined;
  }

  async listByWallet(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, sequence: { $gt: options.afterSequence ?? 0 } },
      { orderBy: { sequence: "asc" }, limit: options.limit + 1 },
    );
    const page = records.slice(0, options.limit);
    const result: LedgerPage = { entries: page.map(toLedgerEntry) };
    if (records.length > options.limit) result.nextAfterSequence = page[page.length - 1]!.sequence;
    return result;
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ balance: string; entries: number }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20, 2)::text as balance,
              count(*)::int as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );
    return { balance: money(row!.balance, currency), entries: row!.entries };
  }
}
