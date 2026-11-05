import { ExponentialBackoff, type RandomSource } from "../shared/exponential-backoff";
import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

/** Outbox publishing never gives up (an event is never lost): 1s → 60s cap, up to 20% jitter (A29). */
export const OUTBOX_BACKOFF = ExponentialBackoff.of({ baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.2 });

const MAX_ERROR_LENGTH = 500;

/**
 * Integration event waiting to be published. Written in the same SQL transaction as the
 * state change it describes; the id is the eventId, so consumers can deduplicate by it.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze(event.toJSON() as unknown as Record<string, unknown>);
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return (this._nextAttemptAt ?? this.occurredAt).getTime() <= now.getTime();
  }

  /** Idempotent: a second publication (allowed by at-least-once) keeps the first timestamp. */
  markPublished(at: Date): void {
    if (this._publishedAt) return;
    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt with exponential backoff. */
  scheduleRetry(now: Date, error?: string, random: RandomSource = Math.random): void {
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + OUTBOX_BACKOFF.delayMs(this._attempts - 1, random));
    if (error !== undefined) this._lastError = error.slice(0, MAX_ERROR_LENGTH);
  }

  snapshot(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: new Date(this.occurredAt.getTime()),
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined,
      publishedAt: this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined,
      lastError: this._lastError,
    };
  }
}
