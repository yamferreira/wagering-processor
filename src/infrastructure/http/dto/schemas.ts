import { z } from "zod";
import { EXTERNAL_KINDS } from "../../../domain/wager/kinds";

/**
 * Strict HTTP contracts (unknown fields are rejected, A14). Money stays a string here; its
 * exact format is validated by the domain (Money.from) so there is a single source of truth.
 */
const identifier = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/, "must be 1-128 printable ASCII characters without spaces");

export const uuidSchema = z.string().uuid("must be a UUID");

const moneySchema = z
  .object({
    amount: z.string({ message: "amount must be a decimal string, e.g. \"25.00\"" }),
    currency: z.string({ message: "currency must be a string" }),
  })
  .strict();

export const createWalletSchema = z
  .object({
    playerId: identifier,
    initialBalance: moneySchema,
  })
  .strict();

export const submitWagerSchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: identifier,
    walletId: uuidSchema,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(EXTERNAL_KINDS as [string, ...string[]], { message: `kind must be one of ${EXTERNAL_KINDS.join(", ")}` }),
    money: moneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict();

export const idempotencyKeySchema = z
  .string({ message: "Idempotency-Key header is required" })
  .regex(/^[\x21-\x7E]{1,255}$/, "Idempotency-Key must be 1-255 printable ASCII characters without spaces");

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z
      .string()
      .regex(/^\d{1,4}$/, "limit must be an integer")
      .transform((value) => Number.parseInt(value, 10))
      .optional(),
  })
  .strict();

export const providerPathSchema = z.object({ providerId: identifier, externalTransactionId: identifier });

export type CreateWalletBody = z.infer<typeof createWalletSchema>;
export type SubmitWagerBody = z.infer<typeof submitWagerSchema>;
