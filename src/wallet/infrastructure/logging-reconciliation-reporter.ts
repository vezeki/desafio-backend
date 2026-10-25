import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_METRICS, type AppMetrics } from "../../shared/application/metrics.ts";
import type { ReconciliationReport, ReconciliationReporter } from "../application/reconcile-wallet.use-case.ts";

@Injectable()
export class LoggingReconciliationReporter implements ReconciliationReporter {
  private readonly logger = new Logger("Reconciliation");

  constructor(@Inject(APP_METRICS) private readonly metrics: AppMetrics) {}

  reconciled(report: ReconciliationReport): void {
    const fields = { walletId: report.walletId, checkedEntries: report.checkedEntries };
    if (report.consistent) {
      this.logger.log(fields, "wallet consistent");
      return;
    }
    this.metrics.reconciliationDivergence();
    this.logger.error(fields, "wallet balance diverges from its ledger");
  }
}
