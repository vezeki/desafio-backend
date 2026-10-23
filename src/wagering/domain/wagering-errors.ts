import { DomainError } from "../../shared/domain/domain-error.ts";
import type { FailureCode } from "./failure-code.ts";
import type { WagerTransactionStatus } from "./wager-transaction-status.ts";

/** Invalid request contract: nothing is persisted. */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: FailureCode,
    reason: string,
  ) {
    super(reason);
  }
}

/** Programming error: an illegal state transition was attempted. Not a business path. */
export class InvalidTransactionStateError extends Error {
  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly attempted: string,
  ) {
    super(`Transaction ${transactionId} cannot ${attempted} from status ${from}`);
    this.name = "InvalidTransactionStateError";
  }
}
