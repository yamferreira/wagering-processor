import type { EventPublisher } from "../ports/event-publisher";
import type { FaultInjector } from "../ports/fault-injector";
import type { Clock } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";

export interface PublishBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface PublishOutboxBatchDeps {
  runner: TransactionRunner;
  publisher: EventPublisher;
  clock: Clock;
  faults: FaultInjector;
  batchSize: number;
}

/**
 * One publishing round (§11):
 *
 *   BEGIN
 *     SELECT … WHERE published_at IS NULL AND next_attempt_at <= now
 *       ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED
 *     publish to the broker
 *     UPDATE published_at (success) | attempts, next_attempt_at, last_error (failure, backoff)
 *   COMMIT
 *
 * The row locks are held across the broker call so concurrent publishers (any number of
 * instances) never pick the same rows; they only ever lock outbox rows, never wallets. If the
 * process dies anywhere before COMMIT, the locks vanish with the connection and another
 * publisher takes the rows over — possibly publishing an event a second time, which is safe
 * because consumers deduplicate by eventId (at-least-once, never lost).
 */
export class PublishOutboxBatch {
  constructor(private readonly deps: PublishOutboxBatchDeps) {}

  async execute(): Promise<PublishBatchResult> {
    const { runner, publisher, clock, faults, batchSize } = this.deps;
    return runner.run(async (repos) => {
      const batch = await repos.outbox.claimDue(clock.now(), batchSize);
      if (batch.length === 0) return { claimed: 0, published: 0, failed: 0 };
      await faults.checkpoint("outbox:after-claim-before-publish");

      let outcome;
      try {
        outcome = await publisher.publish(batch);
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        outcome = { published: [], failed: batch.map((m) => ({ id: m.id, error: message })) };
      }
      await faults.checkpoint("outbox:after-publish-before-mark");

      const now = clock.now();
      const published = new Set(outcome.published);
      const errors = new Map(outcome.failed.map((f) => [f.id, f.error]));
      for (const message of batch) {
        if (published.has(message.id)) message.markPublished(now);
        else message.scheduleRetry(now, errors.get(message.id) ?? "not acknowledged by the broker");
      }
      await repos.outbox.saveDeliveryState(batch);
      return { claimed: batch.length, published: published.size, failed: batch.length - published.size };
    });
  }
}
