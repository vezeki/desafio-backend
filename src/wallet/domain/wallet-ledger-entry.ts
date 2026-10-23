import type { Money } from "../../shared/domain/money.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import { UnbalancedLedgerEntryError } from "./wallet-errors.ts";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this entry; orders entries within a wallet. */
  sequence: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly sequence: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new UnbalancedLedgerEntryError(`amount must be positive, got ${entry.money}`);
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError("balances cannot be negative");
    }
    if (!Number.isInteger(entry.sequence) || entry.sequence < 1) {
      throw new UnbalancedLedgerEntryError(`sequence must be a positive integer, got ${entry.sequence}`);
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${entry.balanceBefore} ${entry.direction} ${entry.money} does not result in ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstruction from persistence: trusts data that was validated when written. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.sequence,
      new Date(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter. Throws CurrencyMismatchError if currencies differ. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance: positive for credits, negative for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
