import type { NextFunction, Request, Response } from "express";
import { logger } from "../logging/logger.ts";
import { correlationIdOf } from "./correlation-id.ts";

const QUIET = new Set(["/metrics", "/health/live", "/health/ready"]);

/** One line per request. The body, the query string and the player id are not included. */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (QUIET.has(req.path)) {
    next();
    return;
  }
  const started = performance.now();
  const correlationId = correlationIdOf(req);
  res.on("finish", () => {
    logger.info(
      {
        correlationId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      },
      "request",
    );
  });
  next();
}
