import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import type { MoneyProps } from "../../shared/domain/money.ts";
import { WalletNotFoundError } from "../domain/wallet-errors.ts";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** storedBalance - calculatedBalance */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Where divergences go besides the response: logs and metrics. Never a silent fix. */
export interface ReconciliationReporter {
  reconciled(report: ReconciliationReport): void;
}

export const RECONCILIATION_REPORTER = Symbol("ReconciliationReporter");

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly reporter: ReconciliationReporter,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    // One snapshot: a debit committed between the two reads would otherwise look like a divergence.
    const report = await this.unitOfWork.snapshot(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const totals = await ctx.ledger.totals(walletId, wallet.currency);
      const difference = wallet.balance.subtract(totals.balance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: totals.balance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.entries,
      };
    });

    this.reporter.reconciled(report);
    return report;
  }
}
