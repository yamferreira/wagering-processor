import type { SubmitWagerCommand } from "../../src/application/use-cases/submit-wager-transaction";
import type { TestQueues } from "./sqs";
import { wagerEnvelope } from "./messaging";

export interface HttpResult {
  status: number;
  body: Record<string, any>;
  /** Which base URL served the request. */
  target: string;
}

/** POST /wagering/transactions with the command's Idempotency-Key. */
export async function postWager(baseUrl: string, command: SubmitWagerCommand): Promise<HttpResult> {
  const { idempotencyKey, ...body } = command;
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, target: baseUrl };
}

/**
 * Fires all commands at once (real parallelism: every request is in flight before the first
 * response), spreading them round-robin over the given base URLs.
 */
export async function fireHttp(baseUrls: string[], commands: SubmitWagerCommand[]): Promise<HttpResult[]> {
  return Promise.all(commands.map((command, i) => postWager(baseUrls[i % baseUrls.length]!, command)));
}

/**
 * Sends one envelope per command to the input queue in batches of 10, all batches in parallel.
 * `groupBy: "random"` gives every message its own MessageGroupId so the broker imposes no
 * ordering at all (A26): correctness must come from the database.
 */
export async function fireSqs(
  queues: TestQueues,
  commands: SubmitWagerCommand[],
  options: { groupBy?: "wallet" | "random"; messageIds?: string[] } = {},
): Promise<string[]> {
  const envelopes = commands.map((command, i) =>
    wagerEnvelope(command, options.messageIds?.[i] ? { messageId: options.messageIds[i]! } : {}),
  );
  const batches: (typeof envelopes)[] = [];
  for (let i = 0; i < envelopes.length; i += 10) batches.push(envelopes.slice(i, i + 10));
  await Promise.all(
    batches.map(async (batch) => {
      const result = await queues.input.sendBatch(
        batch.map((envelope) => ({
          body: JSON.stringify(envelope),
          groupId: options.groupBy === "random" ? crypto.randomUUID() : envelope.data.walletId,
          deduplicationId: crypto.randomUUID(),
        })),
      );
      if (result.failed.length > 0) throw new Error(`SendMessageBatch failures: ${JSON.stringify(result.failed)}`);
    }),
  );
  return envelopes.map((e) => e.messageId);
}
