import { DomainError } from "../../shared/domain/domain-error.ts";
import { FailureCode } from "../domain/failure-code.ts";

/** The idempotency key (or the provider's external id) was already used for a different request. Never a replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor(reason: string) {
    super(reason);
  }
}

export class WagerTransactionNotFoundError extends DomainError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor(description: string) {
    super(`Transaction ${description} not found`);
  }
}
