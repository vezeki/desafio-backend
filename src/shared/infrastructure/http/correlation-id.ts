import { randomUUID } from "node:crypto";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

export const CORRELATION_ID_HEADER = "x-correlation-id";

const ACCEPTED_CORRELATION_ID = /^[\w.:-]{1,128}$/;

type CorrelatedRequest = Request & { correlationId?: string };

/** Reuses the caller's correlation id when it is well formed, otherwise creates one; always echoes it back. */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const received = req.header(CORRELATION_ID_HEADER);
  const correlationId = received && ACCEPTED_CORRELATION_ID.test(received) ? received : randomUUID();
  (req as CorrelatedRequest).correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  next();
}

export function correlationIdOf(req: Request): string | undefined {
  return (req as CorrelatedRequest).correlationId;
}

export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  return correlationIdOf(context.switchToHttp().getRequest<Request>()) ?? randomUUID();
});
