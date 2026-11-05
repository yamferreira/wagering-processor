import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../auth/auth.guard";
import type { Container } from "../../app/container";
import { TOKENS } from "../../app/tokens";

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

/** Open endpoints (no authentication, §9). */
@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(TOKENS.Container) private readonly container: Container) {}

  /** Process is alive (no dependency checks: a DB outage must not restart healthy pods). */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Dependencies reachable: PostgreSQL (and SQS from T17). 503 when any check fails. */
  @Get("ready")
  async ready(@Res() res: Response) {
    const results = await Promise.all(
      this.container.readiness.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return { name, status: "up" as const };
        } catch (error) {
          return { name, status: "down" as const, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const ready = results.every((r) => r.status === "up");
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      checks: Object.fromEntries(results.map(({ name, ...rest }) => [name, rest])),
    });
  }
}
