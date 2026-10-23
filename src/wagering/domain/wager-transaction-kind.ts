export enum WagerTransactionKind {
  /** Internal: initial credit when a wallet is opened. Never accepted from providers. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export function isSubmittableKind(value: unknown): value is SubmittableKind {
  return SUBMITTABLE_KINDS.includes(value as SubmittableKind);
}
