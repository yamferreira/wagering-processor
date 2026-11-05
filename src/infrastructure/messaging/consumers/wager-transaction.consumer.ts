import type { FaultInjector } from "../../../application/ports/fault-injector";
import type { Logger } from "../../../application/ports/logger";
import type { HandleWagerMessage, MessageOutcome } from "../../../application/use-cases/handle-wager-message";
import { enrichLogContext, withLogContext } from "../../observability/log-context";
import { errorFields } from "../../observability/logger";
import type { ReceivedMessage, SqsQueue } from "../sqs/sqs.client";
import { parseWagerEnvelope } from "./envelope.schema";
import { type ClassifiedFailure, classifyConsumerError } from "./error-classifier";

export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

export interface WagerConsumerOptions {
  /** Max messages processed at once by this process (across message groups). */
  concurrency: number;
  /** Long-polling wait (0–20 s). */
  waitTimeSeconds: number;
  /** Application-side receive limit: a RETRY on this receive goes to the DLQ instead (A27). */
  maxReceives: number;
  retryBaseSeconds: number;
  retryCapSeconds: number;
  /** How long stop() waits for in-flight messages before handing them back to the broker. */
  shutdownGraceMs: number;
}

export interface WagerConsumerObserver {
  onProcessed?(outcome: MessageOutcome, durationMs: number): void;
  onRetry?(failure: ClassifiedFailure, receiveCount: number, delaySeconds: number): void;
  onDeadLetter?(failure: ClassifiedFailure, receiveCount: number): void;
  onAbandon?(failure: ClassifiedFailure): void;
}

export interface WagerConsumerDeps {
  input: SqsQueue;
  dlq: SqsQueue;
  handler: HandleWagerMessage;
  faults: FaultInjector;
  logger: Logger;
  observer?: WagerConsumerObserver;
}

/**
 * Long-polling SQS consumer for `WagerTransactionRequested` (§10).
 *
 * - Ack (DeleteMessage) only after the use case committed; the fault point between the two is
 *   where the "crash after commit, before ack" scenario is injected.
 * - Messages of the same MessageGroupId in a batch are processed sequentially (FIFO intent);
 *   different groups run in parallel. Correctness never depends on this ordering: the database
 *   (inbox PK, idempotency constraints, wallet row lock) is the source of truth.
 * - Graceful stop: stop polling, let in-flight messages finish within the grace period, then hand
 *   any still running back to the broker with ChangeMessageVisibility(0). Nothing is lost
 *   (unacked) and nothing is duplicated (inbox).
 */
export class WagerTransactionConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private currentPoll: Promise<ReceivedMessage[]> | undefined;
  private readonly inFlight = new Map<string, { message: ReceivedMessage; done: Promise<void>; released: boolean }>();
  private readonly options: WagerConsumerOptions;

  constructor(
    private readonly deps: WagerConsumerDeps,
    options: WagerConsumerOptions,
  ) {
    this.options = options;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<{ completed: number; released: number }> {
    if (!this.running) return { completed: 0, released: 0 };
    this.running = false;
    // The open long poll is NOT aborted: aborting only cancels the client side, while the broker
    // keeps the ReceiveMessage open and would deliver a released message to this dead poll (making
    // it invisible for a full visibility timeout). It ends by itself within waitTimeSeconds, and
    // whatever it returns is handed straight back (see run()). In-flight work gets the grace period
    // concurrently, so stopping takes at most max(waitTimeSeconds, shutdownGraceMs).
    const pending = [...this.inFlight.values()];
    const grace = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.options.shutdownGraceMs));
    await Promise.all([
      this.currentPoll?.catch(() => undefined),
      Promise.race([Promise.allSettled(pending.map((entry) => entry.done)), grace]),
    ]);

    let released = 0;
    for (const entry of this.inFlight.values()) {
      entry.released = true;
      released++;
      await this.deps.input
        .changeVisibility(entry.message.receiptHandle, 0)
        .catch((error) => this.deps.logger.warn({ ...errorFields(error) }, "could not release message"));
    }
    this.deps.logger.info({ completed: pending.length - released, released }, "consumer stopped");
    return { completed: pending.length - released, released };
  }

  private async run(): Promise<void> {
    let pollFailures = 0;
    while (this.running) {
      const capacity = this.options.concurrency - this.inFlight.size;
      if (capacity <= 0) {
        await Promise.race([...this.inFlight.values()].map((entry) => entry.done));
        continue;
      }
      let batch: ReceivedMessage[];
      try {
        this.currentPoll = this.deps.input.receive({ max: Math.min(10, capacity), waitSeconds: this.options.waitTimeSeconds });
        batch = await this.currentPoll;
        pollFailures = 0;
      } catch (error) {
        if (!this.running) break;
        pollFailures++;
        const delay = Math.min(250 * 2 ** pollFailures, 10_000);
        this.deps.logger.warn({ ...errorFields(error), delayMs: delay }, "sqs receive failed; backing off");
        await sleep(delay);
        continue;
      } finally {
        this.currentPoll = undefined;
      }
      if (!this.running) {
        // Received during shutdown: hand them straight back.
        await Promise.all(
          batch.map((m) =>
            this.deps.input
              .changeVisibility(m.receiptHandle, 0)
              .catch((error) => this.deps.logger.warn({ ...errorFields(error) }, "could not release message")),
          ),
        );
        break;
      }
      this.dispatch(batch);
    }
  }

  private dispatch(batch: ReceivedMessage[]): void {
    const byGroup = new Map<string, ReceivedMessage[]>();
    for (const message of batch) {
      const group = byGroup.get(message.groupId) ?? [];
      group.push(message);
      byGroup.set(message.groupId, group);
    }
    for (const messages of byGroup.values()) {
      let previous: Promise<void> = Promise.resolve();
      for (const message of messages) {
        const entry = { message, done: Promise.resolve(), released: false };
        entry.done = previous
          .then(() => (entry.released ? undefined : this.handle(message, entry)))
          .finally(() => this.inFlight.delete(message.receiptHandle));
        this.inFlight.set(message.receiptHandle, entry);
        previous = entry.done;
      }
    }
  }

  /** Each message runs in its own log context (correlationId, messageId, walletId, providerId, transactionId). */
  private handle(message: ReceivedMessage, entry: { released: boolean }): Promise<void> {
    return withLogContext({ sqsMessageId: message.messageId, receiveCount: message.receiveCount }, () =>
      this.process(message, entry),
    );
  }

  private async process(message: ReceivedMessage, entry: { released: boolean }): Promise<void> {
    const startedAt = performance.now();
    const log = this.deps.logger;
    let outcome: MessageOutcome;
    try {
      const parsed = parseWagerEnvelope(message.body);
      enrichLogContext({
        messageId: parsed.messageId,
        correlationId: parsed.correlationId ?? parsed.messageId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
      });
      const scoped = log;
      outcome = await this.deps.handler.execute(parsed);
      if (outcome.type === "APPLIED") enrichLogContext({ transactionId: outcome.result.transaction.id });
      await this.deps.faults.checkpoint("consumer:after-commit-before-ack");
      if (entry.released) return; // shutdown already handed it back; the redelivery dedupes via inbox
      await this.deps.input.delete(message.receiptHandle);
      const durationMs = performance.now() - startedAt;
      this.deps.observer?.onProcessed?.(outcome, durationMs);
      scoped.info(
        {
          outcome: outcome.type,
          ...(outcome.type === "APPLIED"
            ? {
                txStatus: outcome.result.transaction.status,
                failureCode: outcome.result.transaction.failureCode,
                idempotentReplay: outcome.result.replay,
              }
            : {}),
          durationMs: Math.round(durationMs),
        },
        "message processed",
      );
    } catch (error) {
      await this.fail(message, classifyConsumerError(error), log);
    }
  }

  private async fail(message: ReceivedMessage, failure: ClassifiedFailure, log: Logger): Promise<void> {
    try {
      if (failure.action === "ABANDON") {
        this.deps.observer?.onAbandon?.(failure);
        log.warn({ failure: failure.code }, "message abandoned (no ack); broker will redeliver");
        return;
      }
      if (failure.action === "RETRY" && message.receiveCount < this.options.maxReceives) {
        const delay = Math.min(this.options.retryBaseSeconds * 2 ** message.receiveCount, this.options.retryCapSeconds);
        await this.deps.input.changeVisibility(message.receiptHandle, delay);
        this.deps.observer?.onRetry?.(failure, message.receiveCount, delay);
        log.warn({ failure: failure.code, delaySeconds: delay }, "transient failure; message will be retried");
        return;
      }
      await this.deadLetter(message, failure);
      this.deps.observer?.onDeadLetter?.(failure, message.receiveCount);
      // failure.message is not logged: domain messages may quote amounts (it travels in the DLQ attributes).
      log.error({ failure: failure.code }, "message moved to the DLQ");
    } catch (error) {
      // Could not even reschedule/move it: leave it; the visibility timeout (and, as a last
      // resort, the broker redrive policy) takes over.
      log.error({ ...errorFields(error), failure: failure.code }, "failed to handle consumer failure");
    }
  }

  /** Send-then-delete. A crash in between leaves a DLQ copy plus a redelivery deduped by the inbox. */
  private async deadLetter(message: ReceivedMessage, failure: ClassifiedFailure): Promise<void> {
    await this.deps.dlq.send({
      body: message.body,
      groupId: message.groupId || "dead-letter",
      deduplicationId: `dlq-${message.messageId}`,
      attributes: {
        failureAction: failure.action,
        failureCode: failure.code,
        failureReason: failure.message.slice(0, 256),
        receiveCount: String(message.receiveCount),
      },
    });
    await this.deps.input.delete(message.receiptHandle);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

