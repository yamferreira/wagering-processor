import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  TransientReason,
  UniqueViolationError,
} from "../../application/errors";

const CONNECTION_SQLSTATES = new Set(["08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03", "53300"]);
const CONNECTION_ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EHOSTUNREACH"]);
const CONNECTION_MESSAGES = [/connection terminated/i, /timeout exceeded when trying to connect/i, /connect ECONNREFUSED/i];

function field(error: unknown, name: string): string | undefined {
  if (error && typeof error === "object" && name in error) {
    const value = (error as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** SQLSTATE of a pg/MikroORM error (MikroORM copies the driver fields onto its exceptions). */
export function sqlStateOf(error: unknown): string | undefined {
  const code = field(error, "code") ?? field(error, "sqlState");
  return code && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Maps driver errors to application errors. Anything not recognized is returned unchanged
 * (domain errors, programming errors and permanent database errors such as CHECK violations).
 */
export function translateDbError(error: unknown): unknown {
  if (error instanceof UniqueViolationError || error instanceof TransientInfrastructureError) return error;
  if (error instanceof ConcurrencyConflictError) {
    return new TransientInfrastructureError(TransientReason.ConcurrencyConflict, error.message, { cause: error });
  }
  const state = sqlStateOf(error);
  switch (state) {
    case "23505":
      return new UniqueViolationError(field(error, "constraint"), { cause: error });
    case "55P03":
      return new TransientInfrastructureError(TransientReason.LockTimeout, "Timed out waiting for a wallet lock", { cause: error });
    case "40P01":
      return new TransientInfrastructureError(TransientReason.Deadlock, "Deadlock detected", { cause: error });
    case "40001":
      return new TransientInfrastructureError(TransientReason.SerializationFailure, "Serialization failure", { cause: error });
    case "57014":
      return new TransientInfrastructureError(TransientReason.StatementTimeout, "Statement timeout", { cause: error });
  }
  if (state && CONNECTION_SQLSTATES.has(state)) {
    return new TransientInfrastructureError(TransientReason.ConnectionFailure, "Database unavailable", { cause: error });
  }
  const errno = field(error, "code") ?? field(error, "errno");
  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  if (
    (errno && CONNECTION_ERRNOS.has(errno)) ||
    name === "ConnectionException" ||
    CONNECTION_MESSAGES.some((pattern) => pattern.test(message))
  ) {
    return new TransientInfrastructureError(TransientReason.ConnectionFailure, "Database unavailable", { cause: error });
  }
  return error;
}

/** Errors worth retrying inside the same request (the whole transaction is re-executed). */
export function isRetryableInPlace(error: unknown): boolean {
  return (
    error instanceof TransientInfrastructureError &&
    (error.reason === TransientReason.Deadlock ||
      error.reason === TransientReason.SerializationFailure ||
      error.reason === TransientReason.ConcurrencyConflict)
  );
}
