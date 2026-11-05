import { z } from "zod";
import { messagePayloadHash } from "../../../application/idempotency/payload-hash";
import type { WagerMessage } from "../../../application/use-cases/handle-wager-message";
import { idempotencyKeySchema, submitWagerSchema } from "../../http/dto/schemas";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/**
 * §10 envelope. `data` is the same strict contract as the HTTP body plus `idempotencyKey`
 * (which travels in a header over HTTP). `correlationId` is an optional extension so producers
 * can propagate their trace id; it does not enter any hash.
 */
export const wagerEnvelopeSchema = z
  .object({
    messageId: z.string().regex(/^[\x21-\x7E]{1,128}$/, "messageId must be 1-128 printable ASCII characters"),
    type: z.literal(WAGER_TRANSACTION_REQUESTED),
    occurredAt: z.string().datetime({ offset: true }),
    correlationId: z.string().regex(/^[\x21-\x7E]{1,128}$/).optional(),
    data: submitWagerSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
  })
  .strict();

export type WagerEnvelope = z.infer<typeof wagerEnvelopeSchema>;

/** The body could not be turned into a valid envelope: permanent, straight to the DLQ (A27). */
export class InvalidEnvelopeError extends Error {
  readonly code = "INVALID_ENVELOPE";

  constructor(
    message: string,
    readonly messageId?: string,
  ) {
    super(message);
    this.name = "InvalidEnvelopeError";
  }
}

export function parseWagerEnvelope(body: string): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidEnvelopeError("Message body is not valid JSON");
  }
  const parsed = wagerEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const messageId = typeof (json as { messageId?: unknown })?.messageId === "string" ? (json as { messageId: string }).messageId : undefined;
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new InvalidEnvelopeError(`Invalid ${WAGER_TRANSACTION_REQUESTED} envelope: ${issues}`, messageId);
  }
  const envelope = parsed.data;
  const { idempotencyKey, ...command } = envelope.data;
  return {
    messageId: envelope.messageId,
    payloadHash: messagePayloadHash(envelope),
    correlationId: envelope.correlationId,
    command: { ...command, idempotencyKey },
  };
}
