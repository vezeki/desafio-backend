export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}
