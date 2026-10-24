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

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
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
