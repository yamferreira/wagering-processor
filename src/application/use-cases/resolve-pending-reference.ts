import { applyDecision } from "../../domain/wager/apply-decision";
import { decide } from "../../domain/wager/decide";
import { WagerTransactionStatus as Status } from "../../domain/wager/kinds";
import type { ReferenceRetryPolicy } from "../../domain/wager/reference-retry-policy";
import { type Logger, silentLogger } from "../ports/logger";
import type { PendingReferenceClaim } from "../ports/repositories";
import type { Clock, IdGenerator } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";
import { eventContextFactory } from "./context";
import { outcomeEvents } from "./outcome-events";
import { resolveReference, wakeDependentsOf } from "./references";

export type PendingResolution = "PROCESSED" | "REJECTED" | "STILL_PENDING" | "SKIPPED";

export interface ResolveRoundResult {
  claimed: number;
  resolutions: Record<PendingResolution, number>;
}

export interface ResolvePendingReferenceDeps {
  runner: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  retryPolicy: ReferenceRetryPolicy;
  batchSize: number;
  /** How long a claimed item stays reserved for this worker (crash safety). */
  leaseMs: number;
  logger?: Logger;
}

/**
 * PENDING_REFERENCE worker round (§7.1, A28). Two kinds of short transactions, never nested:
 *
 *  1. claim: `FOR UPDATE SKIP LOCKED` over due rows + lease (next_reference_attempt_at = now + lease);
 *     touches only transaction rows and never waits, so it cannot deadlock with submissions;
 *  2. per item: lock the WALLET first, then the transaction row (the same wallet → transaction
 *     order every other flow uses), re-check it is still PENDING_REFERENCE, resolve the reference
 *     and run the same pure decide()/applyDecision() as a fresh submission.
 *
 * Outcomes: PROCESSED (balance + ledger + events), REJECTED (incl. REFERENCE_NOT_FOUND once the
 * retry budget is exhausted, with WagerTransactionRejected), or rescheduled with backoff (no new
 * event: WagerTransactionPendingReference was emitted when it first became pending).
 * A terminal outcome wakes up the transactions waiting for this one.
 */
export class ResolvePendingReference {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  async runRound(): Promise<ResolveRoundResult> {
    const claims = await this.claim();
    const resolutions: Record<PendingResolution, number> = { PROCESSED: 0, REJECTED: 0, STILL_PENDING: 0, SKIPPED: 0 };
    const log = this.deps.logger ?? silentLogger;
    for (const claim of claims) {
      const resolution = await this.resolve(claim);
      resolutions[resolution]++;
      const fields = { transactionId: claim.id, walletId: claim.walletId, correlationId: claim.id, resolution };
      if (resolution === "STILL_PENDING" || resolution === "SKIPPED") log.debug(fields, "pending reference evaluated");
      else log.info(fields, "pending reference resolved");
    }
    return { claimed: claims.length, resolutions };
  }

  async claim(): Promise<PendingReferenceClaim[]> {
    const now = this.deps.clock.now();
    return this.deps.runner.run((repos) =>
      repos.transactions.leaseDuePendingReferences(now, new Date(now.getTime() + this.deps.leaseMs), this.deps.batchSize),
    );
  }

  async resolve(claim: PendingReferenceClaim): Promise<PendingResolution> {
    const { runner, ids, clock, retryPolicy } = this.deps;
    return runner.run(async (repos) => {
      const wallet = await repos.wallets.lockById(claim.walletId);
      const tx = await repos.transactions.lockById(claim.id);
      if (!wallet || !tx || tx.status !== Status.PendingReference) return "SKIPPED";

      const now = clock.now();
      const lookup = await resolveReference(repos, tx);
      const expectedVersion = wallet.version;
      const outcome = applyDecision(tx, wallet, decide(tx, wallet, lookup), {
        ledgerEntryId: ids.next(),
        at: now,
        retryPolicy,
      });
      await repos.transactions.update(tx, Status.PendingReference);
      if (outcome.status === Status.PendingReference) return "STILL_PENDING";

      const ledgerEntry = outcome.status === Status.Processed ? outcome.ledgerEntry : undefined;
      if (ledgerEntry) {
        await repos.ledger.insert(ledgerEntry);
        await repos.wallets.saveMovement(wallet, expectedVersion);
      }
      const nextContext = eventContextFactory({ correlationId: tx.id, causationId: tx.id, channel: "WORKER" }, ids, clock);
      await repos.outbox.insert(outcomeEvents(tx, wallet, ledgerEntry, nextContext));
      await wakeDependentsOf(repos, tx, now);
      return outcome.status === Status.Processed ? "PROCESSED" : "REJECTED";
    });
  }
}
