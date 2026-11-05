import type { SQL } from "bun";
import { messagePayloadHash } from "../../src/application/idempotency/payload-hash";
import type { SqsQueue } from "../../src/infrastructure/messaging/sqs/sqs.client";

export const AUDIT_CONSUMER = "events-audit";

/**
 * A downstream consumer of `wagering-events.fifo` (A25), used to prove that duplicate
 * publications are safe. It applies each event to a projection (events applied per aggregate)
 * in ONE database transaction together with its inbox row (consumerName = events-audit,
 * messageId = eventId), using the same inbox table and constraint as the service. A duplicate
 * hits the inbox primary key and has no effect.
 */
export class EventAuditConsumer {
  delivered = 0;
  applied = 0;
  duplicates = 0;

  constructor(
    private readonly sql: SQL,
    private readonly queue: SqsQueue,
  ) {}

  static async install(sql: SQL): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS audit_projection (
      aggregate_id varchar(128) PRIMARY KEY,
      events_applied integer NOT NULL
    )`;
  }

  /** Receives until the queue stays empty for `idleRounds` polls. */
  async drain(idleRounds = 2): Promise<void> {
    let idle = 0;
    while (idle < idleRounds) {
      const batch = await this.queue.receive({ max: 10, waitSeconds: 1 });
      if (batch.length === 0) {
        idle++;
        continue;
      }
      idle = 0;
      for (const message of batch) {
        await this.apply(message.body);
        await this.queue.delete(message.receiptHandle); // ack after commit
      }
    }
  }

  private async apply(body: string): Promise<void> {
    const event = JSON.parse(body) as { eventId: string; aggregateId: string };
    this.delivered++;
    const hash = messagePayloadHash(event);
    await this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
        VALUES (${AUDIT_CONSUMER}, ${event.eventId}, ${hash}, now(), now())
        ON CONFLICT (consumer_name, message_id) DO NOTHING
        RETURNING message_id`;
      if (inserted.length === 0) {
        this.duplicates++;
        return;
      }
      await tx`
        INSERT INTO audit_projection (aggregate_id, events_applied) VALUES (${event.aggregateId}, 1)
        ON CONFLICT (aggregate_id) DO UPDATE SET events_applied = audit_projection.events_applied + 1`;
      this.applied++;
    });
  }
}
