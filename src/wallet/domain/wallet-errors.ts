import { DomainError } from "../../shared/domain/domain-error.ts";
import type { Money } from "../../shared/domain/money.ts";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Wallet ${walletId} has insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

export class InvalidWalletMovementError extends DomainError {
  readonly code = "INVALID_WALLET_MOVEMENT";

  constructor(reason: string) {
    super(`Invalid wallet movement: ${reason}`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";

  constructor(reason: string) {
    super(`Invalid wallet: ${reason}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";

  constructor(reason: string) {
    super(`Unbalanced ledger entry: ${reason}`);
  }
}
