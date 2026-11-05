import type { SQL } from "bun";
import type { TestQueues } from "./sqs";
import { waitFor } from "./wait";

export interface SystemBacklog {
  /** Input queue: visible + in flight + delayed. */
  queued: number;
  unpublishedOutbox: number;
  /** PENDING_REFERENCE transactions already due (a healthy worker leaves none behind). */
  duePendingReferences: number;
}

export async function backlog(sql: SQL, queues: TestQueues): Promise<SystemBacklog> {
  const depth = await queues.input.approximateDepth();
  const [row] = await sql`
    SELECT (SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NULL) AS outbox,
           (SELECT COUNT(*)::int FROM wager_transactions
             WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()) AS pending`;
  return { queued: depth.visible + depth.inFlight + depth.delayed, unpublishedOutbox: row.outbox, duePendingReferences: row.pending };
}

/**
 * Waits until the whole system is quiescent — input queue empty, outbox fully published, no due
 * PENDING_REFERENCE — for `stableChecks` consecutive probes (SQS counters are approximate).
 */
export async function waitForQuiescence(
  sql: SQL,
  queues: TestQueues,
  options: { timeoutMs?: number; stableChecks?: number } = {},
): Promise<SystemBacklog> {
  let stable = 0;
  let last: SystemBacklog | undefined;
  await waitFor(
    async () => {
      last = await backlog(sql, queues);
      const idle = last.queued === 0 && last.unpublishedOutbox === 0 && last.duePendingReferences === 0;
      stable = idle ? stable + 1 : 0;
      return stable >= (options.stableChecks ?? 3);
    },
    { description: "system quiescence", timeoutMs: options.timeoutMs ?? 60_000, intervalMs: 250 },
  ).catch((error) => {
    throw new Error(`${(error as Error).message}; backlog=${JSON.stringify(last)}`);
  });
  return last!;
}
