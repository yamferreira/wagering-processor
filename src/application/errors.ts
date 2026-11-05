/**
 * Application/infrastructure-level errors that use cases and adapters need to tell apart.
 * They are not domain errors: they describe the persistence/transport outcome.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Optimistic guard tripped (`UPDATE … WHERE version = ?` affected 0 rows). Should never happen under the wallet lock. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = "CONCURRENCY_CONFLICT";

  constructor(message: string) {
    super(message);
  }
}

/** A database uniqueness guarantee rejected the write; `constraint` identifies which one. */
export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`, options);
  }
}

export enum TransientReason {
  LockTimeout = "LOCK_TIMEOUT",
  Deadlock = "DEADLOCK",
  SerializationFailure = "SERIALIZATION_FAILURE",
  StatementTimeout = "STATEMENT_TIMEOUT",
  ConnectionFailure = "CONNECTION_FAILURE",
  ConcurrencyConflict = "CONCURRENCY_CONFLICT",
  BrokerUnavailable = "BROKER_UNAVAILABLE",
}

/** Temporary infrastructure failure: safe to retry with the same idempotency key (HTTP 503 / SQS retry). */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_ERROR";

  constructor(
    readonly reason: TransientReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code: string;

  constructor(
    readonly resource: "WALLET" | "TRANSACTION",
    readonly id: string,
  ) {
    super(`${resource === "WALLET" ? "Wallet" : "Transaction"} ${id} not found`);
    this.code = `${resource}_NOT_FOUND`;
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}
