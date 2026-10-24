import { z } from "zod";
import type { WagerRequest } from "./submit-wager-transaction.use-case.ts";

/** Inbox identity of the wager queue. Redelivery of the same message id is not applied twice. */
export const WAGER_CONSUMER_NAME = "wager-transactions";

const IDEMPOTENCY_KEY = /^[\x21-\x7E]+$/;

const Envelope = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal("WagerTransactionRequested"),
  data: z.object({
    providerId: z.string().min(1).max(100),
    externalTransactionId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(300).regex(IDEMPOTENCY_KEY).optional(),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().min(1).max(200),
    gameId: z.string().min(1).max(200),
    kind: z.string().min(1).max(20),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: z
      .string()
      .min(1)
      .max(200)
      .nullish()
      .transform((value) => value ?? undefined),
  }),
});

export interface ParsedWagerMessage {
  messageId: string;
  idempotencyKey: string;
  request: WagerRequest;
}

export type ParseWagerMessageResult = { ok: true; message: ParsedWagerMessage } | { ok: false; reason: string };

/** A message that cannot be parsed will never succeed, so the caller dead-letters it. */
export function parseWagerMessage(body: string): ParseWagerMessageResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return { ok: false, reason };
  }
  const { messageId, data } = parsed.data;
  const { idempotencyKey, referenceExternalTransactionId, ...request } = data;
  const key = idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`;
  if (key.length > 300 || !IDEMPOTENCY_KEY.test(key)) {
    return { ok: false, reason: "idempotency key must be visible ASCII of at most 300 characters" };
  }
  return {
    ok: true,
    message: { messageId, idempotencyKey: key, request: { ...request, referenceExternalTransactionId } },
  };
}
