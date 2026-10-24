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
