import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../shared/application/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "../shared/application/id-generator.ts";
import { UNIT_OF_WORK, type UnitOfWork } from "../shared/application/unit-of-work.ts";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case.ts";
import { ProcessDuePendingReferencesUseCase } from "./application/process-due-pending-references.use-case.ts";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case.ts";
import { WageringController } from "./infrastructure/http/wagering.controller.ts";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference.worker.ts";
import { WagerConsumerWorker } from "./infrastructure/workers/wager-consumer.worker.ts";

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new SubmitWagerTransactionUseCase(unitOfWork, ids, clock),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransactionUseCase(unitOfWork),
    },
    {
      provide: ProcessDuePendingReferencesUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new ProcessDuePendingReferencesUseCase(unitOfWork, ids, clock),
    },
    PendingReferenceWorker,
    WagerConsumerWorker,
  ],
  exports: [SubmitWagerTransactionUseCase, ProcessDuePendingReferencesUseCase],
})
export class WageringModule {}
