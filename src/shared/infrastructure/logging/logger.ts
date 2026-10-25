import type { LoggerService } from "@nestjs/common";
import { Writable } from "node:stream";
import pino, { type DestinationStream, type Level, type Logger } from "pino";
import { requestContext } from "../http/correlation-id.ts";

const REDACT = { paths: ["playerId", "*.playerId", "money", "*.money", "req.body"], remove: true };

/** Silent under `bun test`, so the suite does not print a JSON line per request. */
export function loggerLevel(): string {
  if (process.env.NODE_ENV === "test") return "silent";
  return process.env.LOG_LEVEL ?? "info";
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: REDACT,
      mixin() {
        const correlationId = requestContext.getStore()?.correlationId;
        return correlationId ? { correlationId } : {};
      },
    },
    destination,
  );
}

export const logger = createLogger(loggerLevel());

/** Nest's `Logger` writes one JSON object per line, with the correlation id of the request in flight. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly out: Logger = logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.emit("info", message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit("error", message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit("warn", message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    const text = rest.find((part): part is string => typeof part === "string");
    if (message !== null && typeof message === "object") {
      this.out[level](message, text ?? "");
      return;
    }
    this.out[level](text && text !== message ? { context: text } : {}, String(message));
  }
}

export function collectLogs(): { stream: DestinationStream; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () => chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
  };
}
