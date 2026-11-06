import { InboxMessage } from "../../domain/messaging/inbox-message";
import { ApplicationError, NotFoundError, UniqueViolationError } from "../errors";
import type { FaultInjector } from "../ports/fault-injector";
import { type Metrics, noMetrics } from "../ports/metrics";
import type { Clock } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { RequestContext } from "./context";
import type { SubmitResult, SubmitWagerCommand, SubmitWagerTransaction } from "./submit-wager-transaction";

export const INBOX_PRIMARY_KEY = "inbox_messages_pk";

export interface WagerMessage {
  /** Envelope messageId (§10): the inbox deduplication key, stable across redeliveries. */
  messageId: string;
  /** SHA-256 of the canonical envelope; the same messageId with another hash is a permanent error. */
  payloadHash: string;
  correlationId?: string | undefined;
  command: SubmitWagerCommand;
}

export type MessageOutcome =
  /** The wager use case ran (new transaction or idempotent replay by Idempotency-Key). */
  | { type: "APPLIED"; result: SubmitResult }
  /** This exact message (consumerName, messageId) was already handled: no effect. */
  | { type: "DUPLICATE_MESSAGE" }
  /** A9: terminal business outcome on SQS — recorded in the inbox and acknowledged. */
  | { type: "WALLET_NOT_FOUND" };

/** Same messageId, different payload: the producer reused an id. Permanent (DLQ). */
export class MessageIdConflictError extends ApplicationError {
  readonly code = "MESSAGE_ID_CONFLICT";

  constructor(readonly messageId: string) {
    super(`Message ${messageId} was already consumed with a different payload`);
  }
}

export interface HandleWagerMessageDeps {
  consumerName: string;
  submit: SubmitWagerTransaction;
  runner: TransactionRunner;
  clock: Clock;
  faults: FaultInjector;
  metrics?: Metrics;
}

/**
 * SQS entry point (§10). Reuses the HTTP use case; the inbox row is written in the SAME SQL
 * transaction as the wager, ledger, wallet and outbox (§11): either all commit or none does.
 *
 * Deduplication layers, outermost first:
 *  1. inbox fast path (read) — an exact redelivery is acknowledged without locking anything;
 *  2. inbox primary key — two concurrent deliveries of the same message: the second blocks on the
 *     unique index until the first commits, then fails with 23505 and is treated as a duplicate;
 *  3. the wager idempotency constraints — a different messageId for the same Idempotency-Key is
 *     an idempotent replay (or a 409-equivalent conflict, which rolls the inbox row back).
 */
export class HandleWagerMessage {
  constructor(private readonly deps: HandleWagerMessageDeps) {}

  async execute(message: WagerMessage): Promise<MessageOutcome> {
    const { consumerName, runner, submit, faults } = this.deps;
    const known = await runner.read((repos) => repos.inbox.find(consumerName, message.messageId));
    if (known) return this.duplicate(known, message);

    const ctx: RequestContext = {
      correlationId: message.correlationId ?? message.messageId,
      causationId: message.messageId,
      channel: "SQS",
    };
    try {
      const result = await submit.execute(message.command, ctx, {
        withinTransaction: async (repos) => {
          await repos.inbox.insert(this.inboxRecord(message));
          await faults.checkpoint("consumer:after-inbox-insert");
        },
        passthrough: isInboxDuplicate,
      });
      return { type: "APPLIED", result };
    } catch (error) {
      if (isInboxDuplicate(error)) {
        const winner = await runner.read((repos) => repos.inbox.find(consumerName, message.messageId));
        if (winner) return this.duplicate(winner, message);
        throw error;
      }
      if (error instanceof NotFoundError && error.resource === "WALLET") {
        await this.recordTerminal(message);
        (this.deps.metrics ?? noMetrics).unknownWalletMessage(this.deps.consumerName);
        return { type: "WALLET_NOT_FOUND" };
      }
      throw error;
    }
  }

  private duplicate(known: InboxMessage, message: WagerMessage): MessageOutcome {
    if (!known.matchesPayload(message.payloadHash)) throw new MessageIdConflictError(message.messageId);
    (this.deps.metrics ?? noMetrics).inboxDuplicate(this.deps.consumerName);
    return { type: "DUPLICATE_MESSAGE" };
  }

  /** Inbox-only record for terminal outcomes that produce no wager row (A9). */
  private async recordTerminal(message: WagerMessage): Promise<void> {
    try {
      await this.deps.runner.run((repos) => repos.inbox.insert(this.inboxRecord(message)));
    } catch (error) {
      if (!isInboxDuplicate(error)) throw error;
    }
  }

  private inboxRecord(message: WagerMessage): InboxMessage {
    const now = this.deps.clock.now();
    const inbox = InboxMessage.receive({
      messageId: message.messageId,
      consumerName: this.deps.consumerName,
      payloadHash: message.payloadHash,
      receivedAt: now,
    });
    // Effects commit in the same transaction as this row, so it is processed once it is visible.
    inbox.markProcessed(now);
    return inbox;
  }
}

function isInboxDuplicate(error: unknown): boolean {
  return error instanceof UniqueViolationError && error.constraint === INBOX_PRIMARY_KEY;
}
