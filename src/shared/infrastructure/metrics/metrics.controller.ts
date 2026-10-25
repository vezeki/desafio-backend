import { Controller, Get, Inject, Res } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import type { Response } from "express";
import { APP_METRICS } from "../../application/metrics.ts";
import { PrometheusMetrics } from "./prometheus-metrics.ts";

@Controller()
export class MetricsController {
  constructor(
    private readonly em: EntityManager,
    @Inject(APP_METRICS) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get("metrics")
  async scrape(@Res() response: Response): Promise<void> {
    const [row] = await this.em.getConnection().execute<Array<{ pending: number | string; lag: number | string }>>(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))), 0) as lag
         from outbox_messages
        where published_at is null`,
    );
    this.metrics.setOutbox(Number(row?.pending ?? 0), Number(row?.lag ?? 0));
    response.status(200).type(this.metrics.contentType).send(await this.metrics.render());
  }
}
