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
