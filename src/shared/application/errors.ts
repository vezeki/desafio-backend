export interface InputIssue {
  path: string;
  message: string;
}

/** The request is malformed: fixing the input is the only way forward, retrying as is will fail again. */
export class InvalidInputError extends Error {
  constructor(
    message: string,
    readonly issues: InputIssue[] = [],
  ) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** A unique constraint rejected the write — usually a concurrent request that committed first. */
export class UniqueConstraintConflictError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Unique constraint conflict${constraint ? ` on ${constraint}` : ""}`, options);
    this.name = "UniqueConstraintConflictError";
  }
}

/** The database or the broker is temporarily unreachable or overloaded. Safe to retry with the same idempotency key. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientInfrastructureError";
  }
}
