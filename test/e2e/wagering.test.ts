import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProcessDuePendingReferencesUseCase } from "../../src/wagering/application/process-due-pending-references.use-case.ts";
import { startTestApp, type TestApp } from "../support/app.ts";

let api: TestApp;

beforeAll(async () => {
  api = await startTestApp();
});

afterAll(async () => {
  await api.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

interface Target {
  walletId: string;
  playerId: string;
}

async function createWallet(amount: string): Promise<Target> {
  const response = await api.request("POST", "/wallets", { body: { playerId: randomUUID(), initialBalance: brl(amount) } });
  return { walletId: response.body.id, playerId: response.body.playerId };
}

function body(target: Target, overrides: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: brl("25.00"),
    ...overrides,
  };
}

function submit(payload: Record<string, unknown>, key = `${payload.providerId}:${payload.externalTransactionId}`) {
  return api.request("POST", "/wagering/transactions", { body: payload, headers: { "idempotency-key": key } });
}

describe("POST /wagering/transactions", () => {
  test("201 for a processed transaction, in the documented response format", async () => {
    const wallet = await createWallet("1000.00");
    const response = await submit(body(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "PROCESSED", balance: brl("975.00"), idempotentReplay: false });
    expect(response.headers.get("location")).toBe(`/wagering/transactions/${response.body.transactionId}`);
  });

  test("200 with idempotentReplay for the identical request", async () => {
    const wallet = await createWallet("100.00");
    const payload = body(wallet);
    const first = await submit(payload);
    const replay = await submit(payload);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("409 IDEMPOTENCY_CONFLICT for the same key with a different payload", async () => {
    const wallet = await createWallet("100.00");
    const payload = body(wallet);
    await submit(payload);

    const response = await submit({ ...payload, money: brl("26.00") });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("422 with failureCode for a business rejection, the same on replay", async () => {
    const wallet = await createWallet("10.00");
    const payload = body(wallet, { money: brl("50.00") });

    const first = await submit(payload);
    expect(first.status).toBe(422);
    expect(first.headers.get("content-type")).toContain("application/problem+json");
    expect(first.body).toMatchObject({
      status: "REJECTED",
      code: "INSUFFICIENT_FUNDS",
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
      balance: brl("10.00"),
      idempotentReplay: false,
    });

    const replay = await submit(payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });
  });

  test("422 for a reversal without funds, with its own failure code", async () => {
    const wallet = await createWallet("0.00");
    const win = await submit(body(wallet, { kind: "WIN", money: brl("30.00") }));
    await submit(body(wallet, { money: brl("30.00") }));

    const rollback = await submit(body(wallet, { kind: "ROLLBACK", money: brl("30.00"), referenceExternalTransactionId: win.body.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  });

  test("202 while the reference has not arrived, and the same on replay", async () => {
    const wallet = await createWallet("100.00");
    const payload = body(wallet, { kind: "REFUND", referenceExternalTransactionId: `bet-${randomUUID()}` });
    const response = await submit(payload);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: false });

    const replay = await submit(payload);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ transactionId: response.body.transactionId, idempotentReplay: true });
  });

  test("the worker applies a due REFUND after its BET arrives", async () => {
    const target = await createWallet("100.00");
    const betId = `bet-${randomUUID()}`;
    const pending = await submit(body(target, { kind: "REFUND", money: brl("25.00"), referenceExternalTransactionId: betId }));
    expect(pending.status).toBe(202);
    await submit(body(target, { externalTransactionId: betId, money: brl("25.00") }));

    await api.sql`update wager_transactions set next_retry_at = now() - interval '1 second' where id = ${pending.body.transactionId}`;
    await api.app.get(ProcessDuePendingReferencesUseCase).execute(50);

    const got = await api.request("GET", `/wagering/transactions/${pending.body.transactionId}`);
    expect(got.body).toMatchObject({ status: "PROCESSED", referenceTransactionId: expect.any(String) });
    const wallet = await api.request("GET", `/wallets/${target.walletId}`);
    expect(wallet.body.balance).toEqual(brl("100.00"));
  });

  test("400 without Idempotency-Key", async () => {
    const wallet = await createWallet("100.00");
    const response = await api.request("POST", "/wagering/transactions", { body: body(wallet) });

    expect(response.status).toBe(400);
    expect(response.body.issues).toEqual([expect.objectContaining({ path: "idempotency-key" })]);
  });

  test.each([
    ["invalid money", { money: brl("25.5") }, "VALIDATION_ERROR"],
    ["amount as number", { money: { amount: 25, currency: "BRL" } }, "VALIDATION_ERROR"],
    ["unknown kind", { kind: "JACKPOT" }, "VALIDATION_ERROR"],
    ["OPENING from a provider", { kind: "OPENING" }, "KIND_NOT_ALLOWED"],
    ["REFUND without reference", { kind: "REFUND" }, "REFERENCE_REQUIRED"],
    ["BET with reference", { referenceExternalTransactionId: "other" }, "REFERENCE_NOT_ALLOWED"],
    ["walletId that is not a uuid", { walletId: "wallet-1" }, "VALIDATION_ERROR"],
    ["externalTransactionId too long", { externalTransactionId: "x".repeat(201) }, "VALIDATION_ERROR"],
  ])("400 for %s", async (_, overrides, code) => {
    const wallet = await createWallet("100.00");
    const response = await submit(body(wallet, overrides));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(code);
  });

  test("an invalid request leaves nothing behind", async () => {
    const wallet = await createWallet("100.00");
    await submit(body(wallet, { kind: "OPENING" }));
    const [row] = await api.sql`
      select count(*)::int as count from wager_transactions where wallet_id = ${wallet.walletId} and kind <> 'OPENING'`;
    expect(row.count).toBe(0);
  });
});

describe("GET transactions", () => {
  test("by internal id and by provider external id", async () => {
    const wallet = await createWallet("100.00");
    const created = await submit(body(wallet));

    const byId = await api.request("GET", `/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await api.request("GET", `/providers/provider-a/wagering/transactions/${created.body.externalTransactionId}`);

    expect(byId.status).toBe(200);
    const { idempotentReplay: _, ...view } = created.body;
    expect(byId.body).toEqual(view);
    expect(byExternal.body).toEqual(view);
  });

  test("404 for unknown transactions, 400 for a malformed id", async () => {
    expect((await api.request("GET", `/wagering/transactions/${randomUUID()}`)).body.code).toBe("TRANSACTION_NOT_FOUND");
    expect((await api.request("GET", "/providers/provider-a/wagering/transactions/nope")).status).toBe(404);
    expect((await api.request("GET", "/wagering/transactions/abc")).status).toBe(400);
  });
});
