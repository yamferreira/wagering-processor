import type { Repositories } from "./repositories";

export interface TransactionOptions {
  /** Snapshot isolation for consistent multi-statement reads (e.g. reconciliation). */
  isolation?: "READ_COMMITTED" | "REPEATABLE_READ";
  readOnly?: boolean;
}

/**
 * Atomic unit of work. Everything done through the given repositories commits or rolls back
 * together. Implementations retry deadlocks/serialization failures a bounded number of times
 * and translate driver errors into application errors (UniqueViolationError,
 * TransientInfrastructureError, …).
 */
export interface TransactionRunner {
  run<T>(work: (repos: Repositories) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Non-transactional reads (each statement sees the latest committed data). */
  read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
