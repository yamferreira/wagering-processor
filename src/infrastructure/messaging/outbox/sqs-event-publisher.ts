import type { EventPublisher, PublishOutcome } from "../../../application/ports/event-publisher";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import type { SqsQueue } from "../sqs/sqs.client";

/**
 * Publishes outbox messages to `wagering-events.fifo` (A24):
 *  - body: the serialized IntegrationEvent envelope (eventId, eventType, aggregateId, …);
 *  - MessageGroupId = aggregateId (per-aggregate order inside one publisher's batch);
 *  - MessageDeduplicationId = eventId (broker drops re-publications within its 5-minute window;
 *    beyond it, consumers deduplicate by eventId — the broker is never relied upon for this).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly queue: SqsQueue) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { published: [], failed: [] };
    const chunks: OutboxMessage[][] = [];
    for (let i = 0; i < messages.length; i += 10) chunks.push(messages.slice(i, i + 10));

    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const result = await this.queue.sendBatch(
            chunk.map((message) => ({
              body: JSON.stringify(message.payload),
              groupId: message.aggregateId,
              deduplicationId: message.id,
              attributes: { eventType: message.eventType },
            })),
          );
          for (const index of result.succeeded) outcome.published.push(chunk[index]!.id);
          for (const failure of result.failed) {
            outcome.failed.push({ id: chunk[failure.index]!.id, error: `${failure.code}: ${failure.message}` });
          }
        } catch (error) {
          const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          for (const message of chunk) outcome.failed.push({ id: message.id, error: reason });
        }
      }),
    );
    return outcome;
  }
}
