import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../../application/ports/logger";
import type { RequestContext } from "../../application/use-cases/context";
import { currentLogContext, withLogContext } from "../observability/log-context";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_CORRELATION = /^[\x21-\x7E]{1,128}$/;

export type ContextualRequest = Request & { correlationId?: string };

/**
 * Accepts the caller's X-Correlation-Id (when well-formed) or generates one, echoes it back, and
 * runs the rest of the request inside a log context carrying it.
 */
export function correlationMiddleware(req: ContextualRequest, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && VALID_CORRELATION.test(incoming) ? incoming : Bun.randomUUIDv7();
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  withLogContext({ correlationId }, () => next());
}

/**
 * One line per finished request: method, route, status, duration and the identifiers collected
 * during the request (transactionId, walletId, providerId). Health probes log at debug level.
 */
export function requestLogMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    const context = currentLogContext(); // the live store: controllers enrich it
    res.on("finish", () => {
      const route = (req.route as { path?: string } | undefined)?.path;
      const fields = {
        ...context,
        method: req.method,
        route: route ? `${req.baseUrl}${route}` : req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (req.path.startsWith("/health") || req.path === "/metrics") logger.debug(fields, "http request");
      else if (res.statusCode >= 500) logger.error(fields, "http request");
      else logger.info(fields, "http request");
    });
    next();
  };
}

export function httpContext(req: ContextualRequest, causationId?: string): RequestContext {
  const ctx: RequestContext = { correlationId: req.correlationId ?? Bun.randomUUIDv7(), channel: "HTTP" };
  if (causationId !== undefined) ctx.causationId = causationId;
  return ctx;
}
