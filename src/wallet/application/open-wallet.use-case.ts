import { OutboxMessage } from "../../messaging/domain/outbox-message.ts";
import type { Clock } from "../../shared/application/clock.ts";
import { UniqueConstraintConflictError } from "../../shared/application/errors.ts";
import type { IdGenerator } from "../../shared/application/id-generator.ts";
import type { UnitOfWork } from "../../shared/application/unit-of-work.ts";
import { Money, type MoneyProps } from "../../shared/domain/money.ts";
import { WagerTransaction } from "../../wagering/domain/wager-transaction.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import { Wallet } from "../domain/wallet.ts";
import { WalletAlreadyExistsError } from "../domain/wallet-errors.ts";
import { toWalletView, type WalletView } from "./wallet-view.ts";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

const ONE_WALLET_PER_PLAYER_AND_CURRENCY = "uq_wallets_player_currency";

export class OpenWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.unitOfWork.run(async (ctx) => {
        const existing = await ctx.wallets.findByPlayerAndCurrency(command.playerId, initialBalance.currency);
        if (existing) throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);

        const now = this.clock.now();
        const walletId = this.ids.next();
        const hasOpeningCredit = initialBalance.isPositive();
        const openingTransactionId = hasOpeningCredit ? this.ids.next() : undefined;

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: hasOpeningCredit ? this.ids.next() : undefined,
          at: now,
        });
        ctx.wallets.add(wallet);

        if (openingEntry && openingTransactionId) {
          ctx.transactions.add(
            WagerTransaction.createOpening({
              id: openingTransactionId,
              walletId,
              playerId: command.playerId,
              money: initialBalance,
              createdAt: now,
            }),
          );
          ctx.ledger.add(openingEntry);
          ctx.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: command.correlationId,
                occurredAt: now,
              }),
            ),
          );
        }

        return toWalletView(wallet);
      });
    } catch (error) {
      // The pre-check above loses the race when two requests open the same wallet at once; the unique index decides.
      if (error instanceof UniqueConstraintConflictError && error.constraint === ONE_WALLET_PER_PLAYER_AND_CURRENCY) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
