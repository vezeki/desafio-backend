import type { Clock } from "../../shared/application/clock.ts";
import { noopMetrics, type AppMetrics } from "../../shared/application/metrics.ts";
import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import type { OutboxMessage } from "../domain/outbox-message.ts";
import type { IntegrationEventPublisher } from "./ports/event-publisher.ts";

export const DEFAULT_OUTBOX_BATCH = 20;
export const DEFAULT_OUTBOX_LEASE_MS = 30_000;

export interface OutboxTick {
  claimed: number;
  published: number;
  /** The send failed and the row was rescheduled. It stays pending. */
  failed: number;
}

/**
 * Publishes due outbox rows.
 * The lease is committed before any send: publishing holds no database connection, and a dead process
 * loses the row only until `locked_until`. A duplicate send is expected and safe — consumers dedupe by eventId.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly publisher: IntegrationEventPublisher,
    private readonly instanceId: string,
    private readonly leaseMs = DEFAULT_OUTBOX_LEASE_MS,
    /** Runs after the broker accepted the send and before `published_at` is set. The crash test exits here. */
    private readonly afterPublish: () => void = () => {},
    private readonly metrics: AppMetrics = noopMetrics,
  ) {}

  async execute(limit = DEFAULT_OUTBOX_BATCH): Promise<OutboxTick> {
    const now = this.clock.now();
    const claimed = await this.unitOfWork.run((ctx) =>
      ctx.outbox.claimDue(now, new Date(now.getTime() + this.leaseMs), this.instanceId, limit),
    );

    const tick: OutboxTick = { claimed: claimed.length, published: 0, failed: 0 };
    const groups = groupByAggregate(claimed);
    await Promise.all(groups.map((messages) => this.publishGroup(messages, tick)));
    return tick;
  }

  /**
   * One aggregate stays in `occurredAt` order; different aggregates run together.
   * A failure stops the group: the later events wait until the failed one is due again,
   * so a newer balance is not announced before the one that failed to send.
   */
  private async publishGroup(messages: OutboxMessage[], tick: OutboxTick): Promise<void> {
    for (let index = 0; index < messages.length; index++) {
      const outcome = await this.publishOne(messages[index]!);
      if (outcome.kind === "published") {
        tick.published += 1;
        continue;
      }
      if (outcome.kind === "failed") tick.failed += 1;
      const retryAt = outcome.kind === "failed" ? outcome.retryAt : this.clock.now();
      for (const rest of messages.slice(index + 1)) await this.release(rest.id, retryAt);
      return;
    }
  }

  private async publishOne(
    message: OutboxMessage,
  ): Promise<{ kind: "published" } | { kind: "failed"; retryAt: Date } | { kind: "deferred" }> {
    try {
      await this.publisher.publish(message);
      this.afterPublish();
    } catch (error) {
      const retryAt = await this.recordFailure(message.id, error);
      if (retryAt) this.metrics.retry("outbox_publish");
      return retryAt ? { kind: "failed", retryAt } : { kind: "deferred" };
    }
    return (await this.markPublished(message.id)) ? { kind: "published" } : { kind: "deferred" };
  }

  private async markPublished(id: string): Promise<boolean> {
    const now = this.clock.now();
    return this.unitOfWork.run(async (ctx) => {
      const current = await ctx.outbox.findByIdForUpdate(id);
      // Lost the lease, or someone already marked it: do not touch the row. A later claim republishes.
      if (!current?.heldBy(this.instanceId, now)) return false;
      current.markPublished(now);
      ctx.outbox.save(current);
      return true;
    });
  }

  private async recordFailure(id: string, error: unknown): Promise<Date | undefined> {
    const now = this.clock.now();
    const reason = error instanceof Error ? error.message : String(error);
    return this.unitOfWork.run(async (ctx) => {
      const current = await ctx.outbox.findByIdForUpdate(id);
      if (!current?.heldBy(this.instanceId, now)) return undefined;
      current.scheduleRetry(now, undefined, undefined, reason);
      ctx.outbox.save(current);
      return current.nextAttemptAt;
    });
  }

  /** Puts a not-yet-sent event back, due again at `nextAttemptAt`, without counting an attempt. */
  private async release(id: string, nextAttemptAt: Date): Promise<void> {
    const now = this.clock.now();
    await this.unitOfWork.run(async (ctx) => {
      const current = await ctx.outbox.findByIdForUpdate(id);
      if (!current?.heldBy(this.instanceId, now)) return;
      current.release(nextAttemptAt);
      ctx.outbox.save(current);
    });
  }
}

function groupByAggregate(messages: OutboxMessage[]): OutboxMessage[][] {
  const groups = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.aggregateId) ?? [];
    group.push(message);
    groups.set(message.aggregateId, group);
  }
  return [...groups.values()];
}
