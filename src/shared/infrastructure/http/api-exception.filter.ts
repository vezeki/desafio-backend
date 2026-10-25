import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { InvalidInputError, TransientInfrastructureError, type InputIssue } from "../../application/errors.ts";
import { DomainError } from "../../domain/domain-error.ts";
import { correlationIdOf } from "./correlation-id.ts";

/**
 * Error body for every endpoint, after RFC 9457 (Problem Details).
 * The status alone tells the client what to do: 400 fix the request, 404/409/422 do not retry, 503 retry with the same key.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  issues?: InputIssue[];
  correlationId?: string;
}

const RETRY_AFTER_SECONDS = "1";

/** Domain errors that reach HTTP as exceptions. Any other DomainError is a business rule violation (422). */
const DOMAIN_ERROR_RESPONSES: Record<string, { status: number; title: string; code?: string }> = {
  INVALID_MONEY: { status: HttpStatus.BAD_REQUEST, title: "Invalid request", code: "VALIDATION_ERROR" },
  CURRENCY_MISMATCH: { status: HttpStatus.BAD_REQUEST, title: "Invalid request", code: "VALIDATION_ERROR" },
  INVALID_WALLET: { status: HttpStatus.BAD_REQUEST, title: "Invalid request", code: "VALIDATION_ERROR" },
  WALLET_NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: "Wallet not found" },
  WALLET_ALREADY_EXISTS: { status: HttpStatus.CONFLICT, title: "Wallet already exists" },
  // Wager request contracts: rejected before anything is persisted.
  VALIDATION_ERROR: { status: HttpStatus.BAD_REQUEST, title: "Invalid request" },
  KIND_NOT_ALLOWED: { status: HttpStatus.BAD_REQUEST, title: "Invalid request" },
  REFERENCE_REQUIRED: { status: HttpStatus.BAD_REQUEST, title: "Invalid request" },
  REFERENCE_NOT_ALLOWED: { status: HttpStatus.BAD_REQUEST, title: "Invalid request" },
  IDEMPOTENCY_CONFLICT: { status: HttpStatus.CONFLICT, title: "Idempotency conflict" },
  TRANSACTION_NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: "Transaction not found" },
  PROVIDER_MISMATCH: { status: HttpStatus.FORBIDDEN, title: "Provider mismatch" },
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const problem = { ...this.toProblem(error), correlationId: correlationIdOf(request) };
    if (problem.status >= 500) {
      this.logger.error({ err: error, correlationId: problem.correlationId, path: request.path }, "request failed");
    }
    if (problem.status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader("Retry-After", RETRY_AFTER_SECONDS);
    }
    response.status(problem.status).type("application/problem+json").json(problem);
  }

  private toProblem(error: unknown): Problem {
    if (error instanceof InvalidInputError) {
      return problem(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Invalid request", error.message, error.issues);
    }
    if (error instanceof DomainError) {
      const mapped = DOMAIN_ERROR_RESPONSES[error.code];
      if (mapped) return problem(mapped.status, mapped.code ?? error.code, mapped.title, error.message);
      return problem(HttpStatus.UNPROCESSABLE_ENTITY, error.code, "Business rule violated", error.message);
    }
    if (error instanceof TransientInfrastructureError) {
      return problem(HttpStatus.SERVICE_UNAVAILABLE, "INFRASTRUCTURE_UNAVAILABLE", "Temporarily unavailable", "retry with the same request");
    }
    if (error instanceof HttpException) {
      // Raised by the framework itself: malformed JSON body, unknown route, payload too large.
      const status = error.getStatus();
      if (status === HttpStatus.BAD_REQUEST) return problem(status, "VALIDATION_ERROR", "Invalid request", error.message);
      if (status === HttpStatus.NOT_FOUND) return problem(status, "NOT_FOUND", "Not found", error.message);
      return problem(status, `HTTP_${status}`, error.message);
    }
    return problem(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal error");
  }
}

function problem(status: number, code: string, title: string, detail?: string, issues?: InputIssue[]): Problem {
  return {
    type: `urn:wagering:problem:${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(issues?.length ? { issues } : {}),
  };
}