import type { EntityManager } from "@mikro-orm/postgresql";
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from "../../../messaging/infrastructure/persistence/mikro-orm-messaging.repositories.ts";
import { MikroOrmWagerTransactionRepository } from "../../../wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository.ts";
import { MikroOrmLedgerRepository, MikroOrmWalletRepository } from "../../../wallet/infrastructure/persistence/mikro-orm-wallet.repositories.ts";
import { TransientInfrastructureError, UniqueConstraintConflictError } from "../../application/errors.ts";
import type { TransactionContext, UnitOfWork } from "../../application/unit-of-work.ts";
import { ExponentialBackoff } from "../../domain/exponential-backoff.ts";

/** SQLSTATEs where rolling back and running the transaction again is the correct reaction. */
const RETRYABLE_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
]);

const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P03", "08006", "08001", "08003"]);

export interface UnitOfWorkOptions {
  /** Bounded wait for a row lock; a hot wallet fails fast instead of piling up connections. */
  lockTimeoutMs: number;
  maxAttempts: number;
  onRetry?: (reason: string, attempt: number) => void;
}

const DEFAULT_OPTIONS: UnitOfWorkOptions = { lockTimeoutMs: 5_000, maxAttempts: 3 };

export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly options: UnitOfWorkOptions;
  private readonly backoff = new ExponentialBackoff({ baseDelayMs: 20, maxDelayMs: 200, jitterRatio: 0.5 });

  constructor(
    private readonly em: EntityManager,
    options: Partial<UnitOfWorkOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.em.fork().transactional(async (em) => {
          await em.execute(`set local lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
          return work(createContext(em));
        });
      } catch (error) {
        const sqlState = sqlStateOf(error);
        if (sqlState && RETRYABLE_SQLSTATES.has(sqlState) && attempt < this.options.maxAttempts) {
          this.options.onRetry?.(sqlState, attempt);
          await Bun.sleep(this.backoff.delayAfter(attempt));
          continue;
        }
        throw translate(error);
      }
    }
  }

  async read<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await work(createContext(this.em.fork()));
    } catch (error) {
      throw translate(error);
    }
  }
}

function createContext(em: EntityManager): TransactionContext {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

interface DriverErrorShape {
  code?: string;
  sqlState?: string;
  constraint?: string;
  cause?: unknown;
}

function sqlStateOf(error: unknown): string | undefined {
  const shape = error as DriverErrorShape | undefined;
  return shape?.sqlState ?? shape?.code ?? (shape?.cause ? sqlStateOf(shape.cause) : undefined);
}

function constraintOf(error: unknown): string | undefined {
  const shape = error as DriverErrorShape | undefined;
  return shape?.constraint ?? (shape?.cause ? constraintOf(shape.cause) : undefined);
}

/** Maps driver errors to application errors; anything else passes through unchanged. */
function translate(error: unknown): unknown {
  const sqlState = sqlStateOf(error);
  if (sqlState === "23505") {
    return new UniqueConstraintConflictError(constraintOf(error), { cause: error });
  }
  if (sqlState && (RETRYABLE_SQLSTATES.has(sqlState) || CONNECTION_ERROR_CODES.has(sqlState))) {
    return new TransientInfrastructureError(`database unavailable (${sqlState})`, { cause: error });
  }
  return error;
}
