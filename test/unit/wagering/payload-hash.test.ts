import { describe, expect, test } from "bun:test";
import { canonicalJson, hashWagerPayload, type WagerPayload } from "../../../src/wagering/domain/payload-hash.ts";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys recursively and removes whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("omits undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("keeps array order", () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });
});

describe("hashWagerPayload", () => {
  test("is a hex sha256", () => {
    expect(hashWagerPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("does not depend on key order", () => {
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    } satisfies WagerPayload;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
  });

  test("ignores fields outside the business subset", () => {
    const withTransport = { ...payload, idempotencyKey: "other-key", messageId: "msg-1" } as WagerPayload;
    expect(hashWagerPayload(withTransport)).toBe(hashWagerPayload(payload));
  });

  test("absent and undefined reference produce the same hash", () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(hashWagerPayload(payload));
  });

  test.each<[string, Partial<WagerPayload>]>([
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["round", { roundId: "round-988" }],
    ["game", { gameId: "other-game" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["reference", { referenceExternalTransactionId: "transaction-100" }],
  ])("changes when %s changes", (_label, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });
});
