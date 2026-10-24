import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CorrelationId } from "../../../shared/infrastructure/http/correlation-id.ts";
import { parseInput } from "../../../shared/infrastructure/http/parse-input.ts";
import { GetWalletUseCase } from "../../application/get-wallet.use-case.ts";
import {
  LEDGER_PAGE_DEFAULT_LIMIT,
  LEDGER_PAGE_MAX_LIMIT,
  ListWalletLedgerUseCase,
} from "../../application/list-wallet-ledger.use-case.ts";
import { OpenWalletUseCase } from "../../application/open-wallet.use-case.ts";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case.ts";

/** Shape only; the amount format and currency are validated by Money, the single source of those rules. */
const MoneyInput = z.object({ amount: z.string(), currency: z.string() });

const OpenWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: MoneyInput,
});

const WalletParams = z.object({ walletId: z.uuid() });

const LedgerQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX_LIMIT).default(LEDGER_PAGE_DEFAULT_LIMIT),
});

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase) private readonly listLedger: ListWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  open(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const input = parseInput(OpenWalletBody, body);
    return this.openWallet.execute({ ...input, correlationId });
  }

  @Get(":walletId")
  get(@Param() params: unknown) {
    const { walletId } = parseInput(WalletParams, params);
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  ledger(@Param() params: unknown, @Query() query: unknown) {
    const { walletId } = parseInput(WalletParams, params);
    const { cursor, limit } = parseInput(LedgerQuery, query);
    return this.listLedger.execute({ walletId, cursor, limit });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcile(@Param() params: unknown) {
    const { walletId } = parseInput(WalletParams, params);
    return this.reconcileWallet.execute(walletId);
  }
}
