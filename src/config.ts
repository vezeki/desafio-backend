import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  INSTANCE_ID: z.string().min(1).default(`instance-${process.pid}`),

  DATABASE_URL: z.url().default("postgres://wagering:wagering@localhost:5432/wagering"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT_URL: z.url().default("http://localhost:4566"),
  AWS_ACCESS_KEY_ID: z.string().default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().default("test"),
  SQS_WAGER_QUEUE_NAME: z.string().default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().default("wager-transactions-dlq.fifo"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** When omitted, workers run in every environment except `test` (so e2e does not race the poller). */
  WORKERS_ENABLED: z.enum(["true", "false"]).optional(),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),
});

export type AppConfig = Omit<z.infer<typeof ConfigSchema>, "WORKERS_ENABLED"> & { WORKERS_ENABLED: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const { WORKERS_ENABLED, ...rest } = parsed.data;
  return {
    ...rest,
    WORKERS_ENABLED: WORKERS_ENABLED === "true" ? true : WORKERS_ENABLED === "false" ? false : rest.NODE_ENV !== "test",
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
