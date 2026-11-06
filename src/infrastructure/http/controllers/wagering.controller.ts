import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { assertCanActAs } from "../../../application/ports/provider-identity.port";
import type { AuthenticatedRequest } from "../../auth/auth.guard";
import type { Container } from "../../app/container";
import { TOKENS } from "../../app/tokens";
import { idempotencyKeySchema, providerPathSchema, submitWagerSchema, uuidSchema } from "../dto/schemas";
import { presentSubmitResult, presentTransaction } from "../presenters";
import { enrichLogContext } from "../../observability/log-context";
import { type ContextualRequest, httpContext } from "../request-context";

type WageringRequest = AuthenticatedRequest & ContextualRequest;

@Controller()
export class WageringController {
  constructor(@Inject(TOKENS.Container) private readonly container: Container) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Req() req: WageringRequest,
    @Res() res: Response,
  ) {
    const idempotencyKey = idempotencyKeySchema.parse(idempotencyKeyHeader);
    const payload = submitWagerSchema.parse(body);
    enrichLogContext({ providerId: payload.providerId, walletId: payload.walletId });
    if (req.identity) assertCanActAs(req.identity, payload.providerId);
    const result = await this.container.submit.execute({ ...payload, idempotencyKey }, httpContext(req, idempotencyKey));
    enrichLogContext({
      transactionId: result.transaction.id,
      txStatus: result.transaction.status,
      failureCode: result.transaction.failureCode,
      idempotentReplay: result.replay,
    });
    const response = presentSubmitResult(result);
    res.status(response.status).json(response.body);
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    enrichLogContext({ transactionId });
    return presentTransaction(await this.container.getTransaction.byId(uuidSchema.parse(transactionId)));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(@Param() params: unknown, @Req() req: WageringRequest) {
    const { providerId, externalTransactionId } = providerPathSchema.parse(params);
    enrichLogContext({ providerId });
    if (req.identity) assertCanActAs(req.identity, providerId);
    return presentTransaction(await this.container.getTransaction.byExternalId(providerId, externalTransactionId));
  }
}
