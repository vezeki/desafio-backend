import { describe, expect, test } from "bun:test";
import { SystemClock } from "../../../src/shared/application/clock.ts";
import { TransientInfrastructureError } from "../../../src/shared/application/errors.ts";
import { UuidV7Generator } from "../../../src/shared/application/id-generator.ts";
import type { UnitOfWork } from "../../../src/shared/application/unit-of-work.ts";
import { ConsumeWagerMessage, retryDelaySeconds } from "../../../src/wagering/application/consume-wager-message.ts";
import { SubmitWagerTransactionUseCase } from "../../../src/wagering/application/submit-wager-transaction.use-case.ts";
import type { WagerSubmitter } from "../../../src/wagering/application/consume-wager-message.ts";

const never: UnitOfWork = {
  run: () => Promise.reject(new Error("should not touch the database")),
  read: () => Promise.reject(new Error("should not touch the database")),
  snapshot: () => Promise.reject(new Error("should not touch the database")),
};

const submit = new SubmitWagerTransactionUseCase(never, new UuidV7Generator(), new SystemClock());

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: "msg-1",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...overrides,
    },
  });
}

describe("parse and classification", () => {
  test("invalid JSON, a bad contract and an unusable key are dead-lettered without a write", async () => {
    const consume = new ConsumeWagerMessage(submit);

    expect(await consume.execute("{")).toEqual({ action: "dead-letter", reason: "body is not valid JSON" });
    expect(await consume.execute(body({ kind: "OPENING" }))).toMatchObject({ action: "dead-letter" });
    expect(await consume.execute(body({ money: { amount: "25", currency: "BRL" } }))).toMatchObject({ action: "dead-letter" });
    expect(await consume.execute(body({ providerId: "has space" }))).toMatchObject({ action: "dead-letter" });
  });

  test("a settled outcome is acked, a blip is retried", async () => {
    const settled: WagerSubmitter = { execute: () => Promise.resolve({ transaction: {} as never, idempotentReplay: false }) };
    expect(await new ConsumeWagerMessage(settled).execute(body())).toEqual({ action: "ack" });

    const down: WagerSubmitter = { execute: () => Promise.reject(new TransientInfrastructureError("db down")) };
    expect(await new ConsumeWagerMessage(down).execute(body())).toEqual({ action: "retry", reason: "db down" });

    const bug: WagerSubmitter = { execute: () => Promise.reject(new Error("boom")) };
    expect(await new ConsumeWagerMessage(bug).execute(body())).toEqual({ action: "retry", reason: "boom" });
  });

  test("the retry delay doubles and caps at a minute", () => {
    expect(retryDelaySeconds(1)).toBe(1);
    expect(retryDelaySeconds(2)).toBe(2);
    expect(retryDelaySeconds(3)).toBe(4);
    expect(retryDelaySeconds(10)).toBe(60);
    expect(retryDelaySeconds(0)).toBe(1);
  });
});
