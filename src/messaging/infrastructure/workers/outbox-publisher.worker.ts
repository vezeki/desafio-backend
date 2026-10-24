import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../../config.ts";
import { PublishOutboxUseCase } from "../../application/publish-outbox.use-case.ts";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(
    @Inject(PublishOutboxUseCase) private readonly useCase: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.WORKERS_ENABLED) return;
    this.running = true;
    this.currentTick = this.loop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.currentTick;
  }

  private async loop(): Promise<void> {
    this.logger.log(
      { intervalMs: this.config.OUTBOX_POLL_INTERVAL_MS, batch: this.config.OUTBOX_BATCH_SIZE },
      "outbox publisher started",
    );
    while (this.running) {
      try {
        const tick = await this.useCase.execute(this.config.OUTBOX_BATCH_SIZE);
        if (tick.claimed > 0) this.logger.log(tick, "outbox tick");
        if (tick.claimed < this.config.OUTBOX_BATCH_SIZE) {
          await Bun.sleep(this.config.OUTBOX_POLL_INTERVAL_MS);
        }
      } catch (error) {
        this.logger.error({ err: error }, "outbox tick failed");
        await Bun.sleep(this.config.OUTBOX_POLL_INTERVAL_MS);
      }
    }
    this.logger.log("outbox publisher stopped");
  }
}
