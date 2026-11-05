import { TransientInfrastructureError } from "../../../application/errors";
import { InjectedFaultError } from "../../../application/ports/fault-injector";
import { DomainError } from "../../../domain/errors";
import { ApplicationError } from "../../../application/errors";
import { InvalidEnvelopeError } from "./envelope.schema";

/**
 * A27 — what the consumer does with a failed message:
 *  RETRY    transient infrastructure failure → ChangeMessageVisibility(backoff); DLQ after the
 *           application-side receive limit;
 *  DLQ      permanent (invalid envelope/payload, idempotency or messageId conflict, FAILED) →
 *           moved to the DLQ immediately, retrying cannot help;
 *  ABANDON  simulated crash (tests): no ack and no visibility change — the broker redelivers after
 *           the visibility timeout, exactly as if the process had died.
 * Business rejections are not errors at all: they are REJECTED transactions and get acked.
 */
export type ConsumerFailureAction = "RETRY" | "DLQ" | "ABANDON";

export interface ClassifiedFailure {
  action: ConsumerFailureAction;
  code: string;
  message: string;
}

export function classifyConsumerError(error: unknown): ClassifiedFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof InjectedFaultError) return { action: "ABANDON", code: "INJECTED_FAULT", message };
  if (error instanceof TransientInfrastructureError) return { action: "RETRY", code: error.reason, message };
  if (error instanceof InvalidEnvelopeError) return { action: "DLQ", code: error.code, message };
  // Validation, idempotency conflicts, money format, unsupported currency, MESSAGE_ID_CONFLICT,
  // INTERNAL_ERROR (A16: FAILED). All deterministic: the same message fails the same way.
  if (error instanceof DomainError || error instanceof ApplicationError) return { action: "DLQ", code: error.code, message };
  // Unknown (driver/SDK/bug): assume transient, bounded by the receive limit.
  return { action: "RETRY", code: "UNCLASSIFIED", message };
}
