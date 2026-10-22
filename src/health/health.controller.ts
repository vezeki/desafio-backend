import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Response } from "express";
import { APP_CONFIG, type AppConfig } from "../config.ts";

type CheckResult = { status: "up" } | { status: "down"; error: string };

const CHECK_TIMEOUT_MS = 2_000;

@Controller("health")
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("live")
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: "up" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.em.getConnection().execute("select 1")),
      this.check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.SQS_WAGER_QUEUE_NAME }))),
    ]);
    const ready = postgres.status === "up" && sqs.status === "up";
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? "up" : "down", checks: { postgres, sqs } };
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckResult> {
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS)),
      ]);
      return { status: "up" };
    } catch (error) {
      return { status: "down", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
