import { Logger } from "@nestjs/common";
import type { ReconciliationReport, ReconciliationReporter } from "../application/reconcile-wallet.use-case.ts";

export class LoggingReconciliationReporter implements ReconciliationReporter {
  private readonly logger = new Logger("Reconciliation");

  reconciled(report: ReconciliationReport): void {
    if (report.consistent) {
      this.logger.log({ walletId: report.walletId, checkedEntries: report.checkedEntries }, "wallet consistent");
      return;
    }
    this.logger.error(report, "wallet balance diverges from its ledger");
  }
}
