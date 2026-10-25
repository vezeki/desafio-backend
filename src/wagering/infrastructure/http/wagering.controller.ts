import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { assertProviderScope, type ProviderIdentity } from "../../../shared/application/provider-identity.ts";
import { CurrentProvider } from "../../../shared/infrastructure/auth/current-provider.ts";
import { CorrelationId } from "../../../shared/infrastructure/http/correlation-id.ts";
import { MoneyInput } from "../../../shared/infrastructure/http/money-input.ts";
import { parseInput } from "../../../shared/infrastructure/http/parse-input.ts";
import { GetWagerTransactionUseCase } from "../../application/get-wager-transaction.use-case.ts";
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionResult,
} from "../../application/submit-wager-transaction.use-case.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction-status.ts";

/** Visible ASCII, as in the recommended `{providerId}:{externalTransactionId}`. Limits follow the schema columns. */
const SubmitHeaders = z.object({
  "idempotency-key": z
    .string({ error: "Idempotency-Key header is required" })
    .min(1)
    .max(300)
    .regex(/^[\x21-\x7E]+$/, "must be visible ASCII without spaces"),
});

const SubmitBody = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(200),
  gameId: z.string().min(1).max(200),
  // The domain decides which kinds exist and which can be submitted (OPENING → KIND_NOT_ALLOWED).
  kind: z.string().min(1).max(20),
  money: MoneyInput,
  referenceExternalTransactionId: z
    .string()
    .min(1)
    .max(200)
    .nullish()
    .transform((value) => value ?? undefined),
});

const TransactionParams = z.object({ transactionId: z.uuid() });
const ExternalParams = z.object({ providerId: z.string().min(1).max(100), externalTransactionId: z.string().min(1).max(200) });

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly query: GetWagerTransactionUseCase,
  ) {}

  /**
   * 201 processed · 200 replay of a processed transaction · 202 waiting for the reference ·
   * 422 rejected by a business rule (also on replay) · 400 invalid · 409 idempotency conflict · 503 retry.
   */
  @Post("wagering/transactions")
  async submitTransaction(
    @Headers() headers: unknown,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @CurrentProvider() identity: ProviderIdentity | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { "idempotency-key": idempotencyKey } = parseInput(SubmitHeaders, headers);
    const request = parseInput(SubmitBody, body);
    assertProviderScope(identity, request.providerId);
    const result = await this.submit.execute({ idempotencyKey, request, correlationId });
    return respond(res, result);
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param() params: unknown, @CurrentProvider() identity: ProviderIdentity | undefined) {
    const { transactionId } = parseInput(TransactionParams, params);
    const transaction = await this.query.byId(transactionId);
    assertProviderScope(identity, transaction.providerId);
    return transaction;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byExternalId(@Param() params: unknown, @CurrentProvider() identity: ProviderIdentity | undefined) {
    const { providerId, externalTransactionId } = parseInput(ExternalParams, params);
    assertProviderScope(identity, providerId);
    return this.query.byExternalId(providerId, externalTransactionId);
  }
}

function respond(res: Response, { transaction, idempotentReplay }: SubmitWagerTransactionResult) {
  const body = { ...transaction, idempotentReplay };
  res.setHeader("Location", `/wagering/transactions/${transaction.transactionId}`);

  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      res.status(idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED);
      return body;
    case WagerTransactionStatus.PendingReference:
      res.status(HttpStatus.ACCEPTED);
      return body;
    default: {
      // A rejection is a stored outcome: the body is the transaction (whose `status` is REJECTED/FAILED)
      // plus the problem identification fields; the HTTP code is only in the status line.
      const code = transaction.failureCode ?? "PROCESSING_FAILED";
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).type("application/problem+json");
      return {
        type: `urn:wagering:problem:${code.toLowerCase().replaceAll("_", "-")}`,
        title: "Transaction rejected",
        code,
        ...body,
      };
    }
  }
}
