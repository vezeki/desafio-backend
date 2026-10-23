import { createHash } from "node:crypto";
import type { MoneyProps } from "../../shared/domain/money.ts";

/** Business fields of a wager request. Transport metadata and the Idempotency-Key header are not part of it. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * JSON with object keys sorted recursively, no whitespace, and undefined properties omitted.
 * Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value as Json;
}

/** sha256(canonicalJson(businessFields)), hex encoded. */
export function hashWagerPayload(payload: WagerPayload): string {
  const businessFields: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(businessFields)).digest("hex");
}
