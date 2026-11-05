/**
 * Base class for every error raised by the domain layer.
 * `code` is a stable, machine-readable identifier (never localized).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when a state transition is attempted from a terminal state (programming error, not a business path). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(from: string, to: string) {
    super(`Invalid transaction state transition: ${from} → ${to}`);
  }
}

/** Raised when an aggregate would be driven into a state that breaks one of its invariants. */
export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";

  constructor(message: string) {
    super(message);
  }
}

/** Raised when a value object or factory receives structurally invalid data. */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}
