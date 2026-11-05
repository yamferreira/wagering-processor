import type { Channel } from "../use-cases/context";

export type LockConflictType = "lock_timeout" | "deadlock" | "serialization" | "version_conflict";
export type RetryComponent = "db_transaction" | "consumer" | "outbox" | "pending_reference";

/**
 * Business/operational metrics port (§12): use cases report what happened in domain terms; the
 * infrastructure decides how it is exported (prom-client in production, no-op in unit tests).
 */
export interface Metrics {
  /** A transaction reached `status` (new submission, worker resolution or wallet opening). */
  transactionRecorded(kind: string, status: string, channel: Channel): void;
  idempotentReplay(channel: Channel): void;
  idempotencyConflict(reason: string): void;
  /** Same (consumerName, messageId) delivered again and ignored. */
  inboxDuplicate(consumer: string): void;
  retry(component: RetryComponent, reason: string): void;
  deadLettered(reason: string): void;
  /** Time spent waiting for the wallet row lock (SELECT … FOR UPDATE). */
  lockWait(seconds: number): void;
  lockConflict(type: LockConflictType): void;
  processingDuration(channel: Channel, seconds: number): void;
  outboxPublished(count: number): void;
  reconciliationDivergence(): void;
}

export const noMetrics: Metrics = {
  transactionRecorded() {},
  idempotentReplay() {},
  idempotencyConflict() {},
  inboxDuplicate() {},
  retry() {},
  deadLettered() {},
  lockWait() {},
  lockConflict() {},
  processingDuration() {},
  outboxPublished() {},
  reconciliationDivergence() {},
};

/** Seconds elapsed since a `performance.now()` mark. */
export const secondsSince = (mark: number): number => (performance.now() - mark) / 1_000;
