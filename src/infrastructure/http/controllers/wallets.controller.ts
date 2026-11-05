import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Container } from "../../app/container";
import { TOKENS } from "../../app/tokens";
import { createWalletSchema, ledgerQuerySchema, uuidSchema } from "../dto/schemas";
import { presentLedgerEntry, presentReconciliation, presentWallet } from "../presenters";
import { type ContextualRequest, httpContext } from "../request-context";

@Controller("wallets")
export class WalletsController {
  constructor(@Inject(TOKENS.Container) private readonly container: Container) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: ContextualRequest) {
    const command = createWalletSchema.parse(body);
    const wallet = await this.container.createWallet.execute(command, httpContext(req));
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return presentWallet(await this.container.getWallet.execute(uuidSchema.parse(walletId)));
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const { cursor, limit } = ledgerQuerySchema.parse(query);
    const result = await this.container.getLedger.execute({ walletId: uuidSchema.parse(walletId), cursor, limit });
    return {
      walletId: result.wallet.id,
      items: result.entries.map(presentLedgerEntry),
      nextCursor: result.nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    return presentReconciliation(await this.container.reconcile.execute(uuidSchema.parse(walletId)));
  }
}
