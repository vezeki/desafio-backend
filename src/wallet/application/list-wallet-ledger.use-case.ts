import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import type { MoneyProps } from "../../shared/domain/money.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { WalletNotFoundError } from "../domain/wallet-errors.ts";
import { LedgerCursor } from "./ledger-cursor.ts";

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

export interface ListWalletLedgerQuery {
  walletId: string;
  cursor?: string;
  limit: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  sequence: number;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  /** Absent on the last page. */
  nextCursor: string | null;
}

export class ListWalletLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: ListWalletLedgerQuery): Promise<LedgerPageView> {
    const afterSequence = query.cursor ? LedgerCursor.decode(query.walletId, query.cursor) : undefined;

    const page = await this.unitOfWork.read(async (ctx) => {
      if (!(await ctx.wallets.findById(query.walletId))) throw new WalletNotFoundError(query.walletId);
      return ctx.ledger.listByWallet(query.walletId, { afterSequence, limit: query.limit });
    });

    return {
      walletId: query.walletId,
      entries: page.entries.map(toLedgerEntryView),
      nextCursor: page.nextAfterSequence === undefined ? null : LedgerCursor.encode(query.walletId, page.nextAfterSequence),
    };
  }
}

function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    sequence: entry.sequence,
    createdAt: entry.createdAt.toISOString(),
  };
}
