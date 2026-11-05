import { createHash } from "node:crypto";
import type { MoneyProps } from "../../domain/money/money";
import { canonicalJson } from "./canonical-json";

/**
 * Business fields of a wager submission. Exactly these fields enter the hash; the
 * Idempotency-Key header, messageId, occurredAt and any transport metadata do not (A14).
 * HTTP and SQS produce the same hash for the same operation, so replays work across channels.
 */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 (hex) of the canonical JSON of the business fields. */
export function wagerPayloadHash(fields: WagerBusinessFields): string {
  // Pick explicitly so unexpected properties can never leak into the hash.
  const subset = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(subset));
}

/** Hash for the internal OPENING transaction (A17). */
export function openingPayloadHash(fields: { walletId: string; playerId: string; money: MoneyProps }): string {
  return sha256Hex(
    canonicalJson({
      kind: "OPENING",
      walletId: fields.walletId,
      playerId: fields.playerId,
      money: { amount: fields.money.amount, currency: fields.money.currency },
    }),
  );
}

/** Hash of an arbitrary message body (used by the inbox to detect a reused messageId). */
export function messagePayloadHash(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}
