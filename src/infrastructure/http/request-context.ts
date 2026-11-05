import type { NextFunction, Request, Response } from "express";
import type { RequestContext } from "../../application/use-cases/context";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_CORRELATION = /^[\x21-\x7E]{1,128}$/;

export type ContextualRequest = Request & { correlationId?: string };

/** Accepts the caller's X-Correlation-Id (when well-formed) or generates one; echoes it back. */
export function correlationMiddleware(req: ContextualRequest, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && VALID_CORRELATION.test(incoming) ? incoming : Bun.randomUUIDv7();
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  next();
}

export function httpContext(req: ContextualRequest, causationId?: string): RequestContext {
  const ctx: RequestContext = { correlationId: req.correlationId ?? Bun.randomUUIDv7(), channel: "HTTP" };
  if (causationId !== undefined) ctx.causationId = causationId;
  return ctx;
}
