import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { placeBet } from "../support/fixtures.ts";
import { startTestApp, type TestApp } from "../support/app.ts";
import { createTestPersistence, type TestPersistence } from "../support/orm.ts";

let api: TestApp;
let p: TestPersistence;

beforeAll(async () => {
  api = await startTestApp();
  p = await createTestPersistence();
});

afterAll(async () => {
  await p.close();
  await api.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function createWallet(amount = "100.00", playerId = randomUUID()) {
  const response = await api.request("POST", "/wallets", { body: { playerId, initialBalance: brl(amount) } });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
}

function expectProblem(response: { status: number; headers: Headers; body: any }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.body).toMatchObject({ status, code });
  expect(response.body.correlationId).toBe(response.headers.get("x-correlation-id"));
}

describe("POST /wallets", () => {
  test("creates the wallet with its opening balance", async () => {
    const playerId = randomUUID();
    const response = await api.request("POST", "/wallets", { body: { playerId, initialBalance: brl("1000.00") } });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ playerId, balance: brl("1000.00"), version: 1 });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("propagates the caller's correlation id to the response and to the event", async () => {
    const correlationId = `test-${randomUUID()}`;
    const response = await api.request("POST", "/wallets", {
      body: { playerId: randomUUID(), initialBalance: brl("5.00") },
      headers: { "x-correlation-id": correlationId },
    });

    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    const [event] = await api.sql`select payload from outbox_messages where aggregate_id = ${response.body.id}`;
    expect(event.payload.correlationId).toBe(correlationId);
  });

  test("a duplicate wallet for the same player and currency is a conflict", async () => {
    const wallet = await createWallet("10.00");
    const response = await api.request("POST", "/wallets", { body: { playerId: wallet.playerId, initialBalance: brl("10.00") } });
    expectProblem(response, 409, "WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["missing playerId", { initialBalance: brl("1.00") }],
    ["playerId is not a uuid", { playerId: "player-1", initialBalance: brl("1.00") }],
    ["amount as number", { playerId: randomUUID(), initialBalance: { amount: 10, currency: "BRL" } }],
    ["amount without cents", { playerId: randomUUID(), initialBalance: brl("10") }],
    ["negative amount", { playerId: randomUUID(), initialBalance: brl("-1.00") }],
    ["lowercase currency", { playerId: randomUUID(), initialBalance: { amount: "1.00", currency: "brl" } }],
  ])("400 when %s", async (_, body) => {
    expectProblem(await api.request("POST", "/wallets", { body }), 400, "VALIDATION_ERROR");
  });

  test("400 lists every invalid field", async () => {
    const response = await api.request("POST", "/wallets", { body: { playerId: 1 } });
    expectProblem(response, 400, "VALIDATION_ERROR");
    expect(response.body.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(["initialBalance", "playerId"]);
  });

  test("400 for a body that is not JSON", async () => {
    expectProblem(await api.request("POST", "/wallets", { body: "{ not json" }), 400, "VALIDATION_ERROR");
  });
});

describe("GET /wallets/:walletId", () => {
  test("returns the wallet", async () => {
    const wallet = await createWallet("42.00");
    const response = await api.request("GET", `/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: wallet.id, balance: brl("42.00"), version: 1 });
  });

  test("404 for an unknown wallet, 400 for a malformed id", async () => {
    expectProblem(await api.request("GET", `/wallets/${randomUUID()}`), 404, "WALLET_NOT_FOUND");
    expectProblem(await api.request("GET", "/wallets/not-a-uuid"), 400, "VALIDATION_ERROR");
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  test("pages through the ledger in order with an opaque cursor", async () => {
    const wallet = await createWallet("100.00");
    for (const amount of ["1.00", "2.00", "3.00"]) {
      await placeBet(p.unitOfWork, p.ids, { walletId: wallet.id, playerId: wallet.playerId }, amount);
    }

    const first = await api.request("GET", `/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.entries.map((entry: { sequence: number }) => entry.sequence)).toEqual([1, 2]);
    expect(first.body.entries[0]).toMatchObject({
      direction: "CREDIT",
      amount: brl("100.00"),
      balanceBefore: brl("0.00"),
      balanceAfter: brl("100.00"),
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await api.request("GET", `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.entries.map((entry: { sequence: number; balanceAfter: unknown }) => [entry.sequence, entry.balanceAfter])).toEqual([
      [3, brl("97.00")],
      [4, brl("94.00")],
    ]);
    expect(second.body.nextCursor).toBeNull();
  });

  test("defaults to 50 entries and an empty page for a wallet without movements", async () => {
    const wallet = await createWallet("0.00");
    const response = await api.request("GET", `/wallets/${wallet.id}/ledger`);
    expect(response.body).toEqual({ walletId: wallet.id, entries: [], nextCursor: null });
  });

  test("a cursor is only valid for the wallet that issued it", async () => {
    const [a, b] = [await createWallet("10.00"), await createWallet("10.00")];
    await placeBet(p.unitOfWork, p.ids, { walletId: a.id, playerId: a.playerId }, "1.00");
    const page = await api.request("GET", `/wallets/${a.id}/ledger?limit=1`);

    expectProblem(await api.request("GET", `/wallets/${b.id}/ledger?cursor=${page.body.nextCursor}`), 400, "VALIDATION_ERROR");
    expectProblem(await api.request("GET", `/wallets/${a.id}/ledger?cursor=garbage`), 400, "VALIDATION_ERROR");
  });

  test.each(["0", "201", "abc", "1.5"])("400 for limit=%s", async (limit) => {
    const wallet = await createWallet("1.00");
    expectProblem(await api.request("GET", `/wallets/${wallet.id}/ledger?limit=${limit}`), 400, "VALIDATION_ERROR");
  });

  test("404 for an unknown wallet", async () => {
    expectProblem(await api.request("GET", `/wallets/${randomUUID()}/ledger`), 404, "WALLET_NOT_FOUND");
  });
});

describe("POST /wallets/:walletId/reconciliation", () => {
  test("a wallet with movements is consistent with its ledger", async () => {
    const wallet = await createWallet("100.00");
    await placeBet(p.unitOfWork, p.ids, { walletId: wallet.id, playerId: wallet.playerId }, "25.00");

    const response = await api.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl("75.00"),
      calculatedBalance: brl("75.00"),
      difference: brl("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("a zero-balance wallet without entries is consistent", async () => {
    const wallet = await createWallet("0.00");
    const response = await api.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.body).toMatchObject({ consistent: true, checkedEntries: 0, difference: brl("0.00") });
  });

  test("a divergence is reported, not corrected", async () => {
    const wallet = await createWallet("100.00");
    // The triggers make this impossible through normal writes; replica mode turns them off for this transaction only.
    await api.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance_amount = 130.00 where id = ${wallet.id}`;
    });

    const response = await api.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      storedBalance: brl("130.00"),
      calculatedBalance: brl("100.00"),
      difference: brl("30.00"),
      consistent: false,
      checkedEntries: 1,
    });
    const [row] = await api.sql`select balance_amount from wallets where id = ${wallet.id}`;
    expect(row.balance_amount).toBe("130.00");
  });

  test("404 for an unknown wallet", async () => {
    expectProblem(await api.request("POST", `/wallets/${randomUUID()}/reconciliation`), 404, "WALLET_NOT_FOUND");
  });
});

test("unknown routes answer with the same problem format", async () => {
  expectProblem(await api.request("GET", "/nope"), 404, "NOT_FOUND");
});
