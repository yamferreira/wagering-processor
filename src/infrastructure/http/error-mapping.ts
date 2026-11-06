import { HttpException } from "@nestjs/common";
import { ZodError } from "zod";
import {
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from "../../application/errors";
import { ProviderForbiddenError, UnauthenticatedError } from "../../application/ports/provider-identity.port";
import { InternalProcessingError } from "../../application/use-cases/submit-wager-transaction";
import { ValidationError } from "../../domain/errors";
import { InvalidCurrencyError, InvalidMoneyError, MoneyOverflowError } from "../../domain/money/money.errors";
import { FailureCode } from "../../domain/wager/failure-code";
import { IdempotencyConflictError } from "../../domain/wager/idempotency";
import { failedTransactionBody } from "./presenters";

export interface ErrorBody {
  error: { code: string; message: string; [detail: string]: unknown };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

/** Thrown by the JSON body parser on malformed input. */
export class MalformedJsonError extends Error {}

const error = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MappedError => ({
  status,
  body: { error: { code, message, ...details } },
});

/**
 * Single mapping from errors to HTTP, used by every endpoint (§9). Status codes alone let
 * the provider decide: 400 fix the payload, 404 unknown resource, 409 conflict (do not resend as
 * is), 422 business rejection (see failureCode), 503 transient (resend with the same key), 500
 * permanent internal error.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof MalformedJsonError) return error(400, "MALFORMED_JSON", "Request body is not valid JSON");
  if (err instanceof ZodError) {
    return error(400, "VALIDATION_ERROR", "Request is invalid", {
      issues: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (err instanceof ValidationError) {
    return error(400, "VALIDATION_ERROR", err.message, err.field ? { field: err.field } : {});
  }
  if (err instanceof InvalidMoneyError || err instanceof InvalidCurrencyError || err instanceof MoneyOverflowError) {
    return error(400, err.code, err.message);
  }
  if (err instanceof UnauthenticatedError) return error(401, err.code, err.message);
  if (err instanceof ProviderForbiddenError) return error(403, err.code, err.message);
  if (err instanceof NotFoundError) return error(404, err.code, err.message);
  if (err instanceof IdempotencyConflictError) {
    return error(409, err.code, err.message, { existingTransactionId: err.existingTransactionId });
  }
  if (err instanceof WalletAlreadyExistsError) return error(409, err.code, err.message);
  if (err instanceof TransientInfrastructureError) {
    return {
      ...error(503, err.code, "Temporary infrastructure failure; retry with the same Idempotency-Key", {
        reason: err.reason,
      }),
      headers: { "Retry-After": "1" },
    };
  }
  if (err instanceof InternalProcessingError) {
    // Recorded as FAILED: same body the replay will return. Otherwise nothing was persisted.
    if (err.transactionId) {
      return { status: 500, body: failedTransactionBody(err.transactionId, FailureCode.InternalInvariantViolation, false) };
    }
    return error(500, err.code, err.message, { transactionId: null });
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404) return error(404, "ROUTE_NOT_FOUND", "Route not found");
    if (status === 413) return error(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    return error(status, "HTTP_ERROR", err.message);
  }
  return error(500, "INTERNAL_ERROR", "Unexpected internal error");
}
