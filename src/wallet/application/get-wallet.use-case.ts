import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import { WalletNotFoundError } from "../domain/wallet-errors.ts";
import { toWalletView, type WalletView } from "./wallet-view.ts";

export class GetWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.unitOfWork.read((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}
