import type { EventContext } from "../../domain/messaging/integration-event";
import type { Clock, IdGenerator } from "../ports/system";

export type Channel = "HTTP" | "SQS" | "WORKER";

/** Cross-cutting request metadata, propagated into logs and integration events. */
export interface RequestContext {
  correlationId: string;
  /** What caused this unit of work (SQS messageId, Idempotency-Key, …). */
  causationId?: string;
  channel: Channel;
}

export function eventContextFactory(ctx: RequestContext, ids: IdGenerator, clock: Clock): () => EventContext {
  return () => {
    const event: EventContext = { eventId: ids.next(), correlationId: ctx.correlationId, occurredAt: clock.now() };
    if (ctx.causationId !== undefined) event.causationId = ctx.causationId;
    return event;
  };
}
