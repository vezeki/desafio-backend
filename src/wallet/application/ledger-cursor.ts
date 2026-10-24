import { InvalidInputError } from "../../shared/application/errors.ts";

/**
 * Opaque pagination cursor: the last sequence returned, bound to its wallet.
 * The ledger is append-only and ordered by sequence, so a cursor never skips or repeats entries.
 */
export const LedgerCursor = {
  encode(walletId: string, afterSequence: number): string {
    return Buffer.from(JSON.stringify({ w: walletId, s: afterSequence })).toString("base64url");
  },

  decode(walletId: string, cursor: string): number {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw invalidCursor();
    }
    const { w, s } = (decoded ?? {}) as { w?: unknown; s?: unknown };
    if (w !== walletId || typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) throw invalidCursor();
    return s;
  },
};

const invalidCursor = () => new InvalidInputError("invalid cursor", [{ path: "cursor", message: "not a cursor issued for this wallet" }]);
