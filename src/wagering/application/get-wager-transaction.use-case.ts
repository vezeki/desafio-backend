import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import { WagerTransactionNotFoundError } from "./wagering-application-errors.ts";
import { toWagerTransactionView, type WagerTransactionView } from "./wager-transaction-view.ts";

export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.read((ctx) => ctx.transactions.findById(transactionId));
    if (!transaction) throw new WagerTransactionNotFoundError(transactionId);
    return toWagerTransactionView(transaction);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.read((ctx) =>
      ctx.transactions.findByProviderExternalId(providerId, externalTransactionId),
    );
    if (!transaction) throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toWagerTransactionView(transaction);
  }
}
