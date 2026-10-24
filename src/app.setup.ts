import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ApiExceptionFilter } from "./shared/infrastructure/http/api-exception.filter.ts";
import { correlationIdMiddleware } from "./shared/infrastructure/http/correlation-id.ts";

/** HTTP setup shared by the real process and the end-to-end tests. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.disable("x-powered-by");
  express.use(correlationIdMiddleware);
  express.useGlobalFilters(new ApiExceptionFilter());
  express.enableShutdownHooks();
}
