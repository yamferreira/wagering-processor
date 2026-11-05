import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface PublishOutcome {
  /** Outbox ids accepted by the broker. */
  published: string[];
  failed: { id: string; error: string }[];
}

/**
 * Broker-facing side of the Transactional Outbox. At-least-once: the same event may be
 * published more than once (crash between publish and mark); consumers deduplicate by eventId.
 * Implementations report per-message results and should not throw for partial failures.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome>;
}
