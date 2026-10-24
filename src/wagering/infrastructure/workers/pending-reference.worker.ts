import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../../config.ts";
import { ProcessDuePendingReferencesUseCase } from "../../application/process-due-pending-references.use-case.ts";

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ProcessDuePendingReferencesUseCase) private readonly useCase: ProcessDuePendingReferencesUseCase,
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
      { intervalMs: this.config.PENDING_REFERENCE_POLL_INTERVAL_MS, batch: this.config.PENDING_REFERENCE_BATCH_SIZE },
      "pending-reference worker started",
    );
    while (this.running) {
      try {
        const tick = await this.useCase.execute(this.config.PENDING_REFERENCE_BATCH_SIZE);
        if (tick.claimed > 0) {
          this.logger.log(tick, "pending-reference tick");
        }
        // A full batch means there is probably more due work; skip the idle wait.
        if (tick.claimed < this.config.PENDING_REFERENCE_BATCH_SIZE) {
          await Bun.sleep(this.config.PENDING_REFERENCE_POLL_INTERVAL_MS);
        }
      } catch (error) {
        this.logger.error({ err: error }, "pending-reference tick failed");
        await Bun.sleep(this.config.PENDING_REFERENCE_POLL_INTERVAL_MS);
      }
    }
    this.logger.log("pending-reference worker stopped");
  }
}
