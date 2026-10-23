export enum FailureCode {
  // The provider must fix the request before sending it again.
  ValidationError = "VALIDATION_ERROR",
  KindNotAllowed = "KIND_NOT_ALLOWED",
  ReferenceRequired = "REFERENCE_REQUIRED",
  ReferenceNotAllowed = "REFERENCE_NOT_ALLOWED",
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",

  // Final business decisions: resending the same request gives the same answer.
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",

  // Infrastructure.
  InfrastructureUnavailable = "INFRASTRUCTURE_UNAVAILABLE",
  ProcessingFailed = "PROCESSING_FAILED",
}

export enum FailureCategory {
  /** Fix the payload, then send again. */
  FixPayload = "FIX_PAYLOAD",
  /** Do not resend: the outcome is final. */
  Final = "FINAL",
  /** Temporary: resend the same request (same idempotency key) later. */
  Retry = "RETRY",
}

export const FAILURE_CATEGORY: Readonly<Record<FailureCode, FailureCategory>> = {
  [FailureCode.ValidationError]: FailureCategory.FixPayload,
  [FailureCode.KindNotAllowed]: FailureCategory.FixPayload,
  [FailureCode.ReferenceRequired]: FailureCategory.FixPayload,
  [FailureCode.ReferenceNotAllowed]: FailureCategory.FixPayload,
  [FailureCode.IdempotencyConflict]: FailureCategory.FixPayload,

  [FailureCode.WalletNotFound]: FailureCategory.Final,
  [FailureCode.WalletPlayerMismatch]: FailureCategory.Final,
  [FailureCode.CurrencyMismatch]: FailureCategory.Final,
  [FailureCode.InsufficientFunds]: FailureCategory.Final,
  [FailureCode.ReversalInsufficientFunds]: FailureCategory.Final,
  [FailureCode.ReferenceNotFound]: FailureCategory.Final,
  [FailureCode.ReferenceMismatch]: FailureCategory.Final,
  [FailureCode.ReferenceKindNotAllowed]: FailureCategory.Final,
  [FailureCode.ReferenceNotProcessed]: FailureCategory.Final,
  [FailureCode.ReferenceAlreadyReversed]: FailureCategory.Final,
  [FailureCode.AmountMismatch]: FailureCategory.Final,

  [FailureCode.InfrastructureUnavailable]: FailureCategory.Retry,
  [FailureCode.ProcessingFailed]: FailureCategory.Final,
};
