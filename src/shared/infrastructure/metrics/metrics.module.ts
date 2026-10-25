import { Global, Module } from "@nestjs/common";
import { APP_METRICS } from "../../application/metrics.ts";
import { MetricsController } from "./metrics.controller.ts";
import { PrometheusMetrics } from "./prometheus-metrics.ts";

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: APP_METRICS, useClass: PrometheusMetrics }],
  exports: [APP_METRICS],
})
export class MetricsModule {}
