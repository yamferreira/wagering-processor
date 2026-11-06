import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../auth/auth.guard";
import type { Container } from "../../app/container";
import { TOKENS } from "../../app/tokens";

/** Prometheus exposition (§12). Open like the health endpoints (scraped from inside the network). */
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(TOKENS.Container) private readonly container: Container) {}

  @Get()
  async metrics(@Res() res: Response) {
    const { contentType, body } = await this.container.metrics.render();
    res.status(200).setHeader("content-type", contentType).send(body);
  }
}
