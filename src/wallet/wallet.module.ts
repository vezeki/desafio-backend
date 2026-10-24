import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../shared/application/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "../shared/application/id-generator.ts";
import { UNIT_OF_WORK, type UnitOfWork } from "../shared/application/unit-of-work.ts";
import { GetWalletUseCase } from "./application/get-wallet.use-case.ts";
import { ListWalletLedgerUseCase } from "./application/list-wallet-ledger.use-case.ts";
import { OpenWalletUseCase } from "./application/open-wallet.use-case.ts";
import {
  RECONCILIATION_REPORTER,
  ReconcileWalletUseCase,
  type ReconciliationReporter,
} from "./application/reconcile-wallet.use-case.ts";
import { WalletsController } from "./infrastructure/http/wallets.controller.ts";
import { LoggingReconciliationReporter } from "./infrastructure/logging-reconciliation-reporter.ts";

@Module({
  controllers: [WalletsController],
  providers: [
    { provide: RECONCILIATION_REPORTER, useClass: LoggingReconciliationReporter },
    {
      provide: OpenWalletUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) => new OpenWalletUseCase(unitOfWork, ids, clock),
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWalletUseCase(unitOfWork),
    },
    {
      provide: ListWalletLedgerUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new ListWalletLedgerUseCase(unitOfWork),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, RECONCILIATION_REPORTER],
      useFactory: (unitOfWork: UnitOfWork, reporter: ReconciliationReporter) => new ReconcileWalletUseCase(unitOfWork, reporter),
    },
  ],
})
export class WalletModule {}
