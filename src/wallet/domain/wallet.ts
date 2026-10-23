import { CurrencyMismatchError } from "../../shared/domain/domain-error.ts";
import { Money } from "../../shared/domain/money.ts";
import { LedgerDirection } from "./ledger-direction.ts";
import { WalletLedgerEntry } from "./wallet-ledger-entry.ts";
import { InsufficientFundsError, InvalidWalletError, InvalidWalletMovementError } from "./wallet-errors.ts";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Internal OPENING transaction that justifies the initial credit. Required when initialBalance > 0. */
  openingTransactionId?: string;
  openingEntryId?: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the initial balance is positive. */
  openingEntry?: WalletLedgerEntry;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const INITIAL_WALLET_VERSION = 1;

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (!props.id) throw new InvalidWalletError("id is required");
    if (!props.playerId) throw new InvalidWalletError("playerId is required");
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError(`initial balance cannot be negative, got ${props.initialBalance}`);
    }

    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      INITIAL_WALLET_VERSION,
      new Date(props.at),
      new Date(props.at),
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.openingTransactionId || !props.openingEntryId) {
      throw new InvalidWalletError("a positive initial balance requires an OPENING transaction and ledger entry");
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      sequence: INITIAL_WALLET_VERSION,
      createdAt: new Date(props.at),
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Throws InsufficientFundsError without changing state when the balance does not cover the amount. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id, this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** The only place where the balance changes: it always produces the matching ledger entry. */
  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      sequence: this._version + 1,
      createdAt: new Date(movement.at),
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertValidMovement(movement: WalletMovement): void {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletMovementError(`amount must be positive, got ${movement.money}`);
    }
    if (!movement.transactionId || !movement.entryId) {
      throw new InvalidWalletMovementError("transactionId and entryId are required");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
