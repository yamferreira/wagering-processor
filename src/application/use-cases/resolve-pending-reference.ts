import { applyDecision } from "../../domain/wager/apply-decision";
import { decide } from "../../domain/wager/decide";
import { FailureCode } from "../../domain/wager/failure-code";
import { WagerTransactionStatus as Status } from "../../domain/wager/kinds";
import type { ReferenceRetryPolicy } from "../../domain/wager/reference-retry-policy";
import { TransientInfrastructureError } from "../errors";
import { type FaultInjector, InjectedFaultError, noFaults } from "../ports/fault-injector";
import { type Logger, silentLogger } from "../ports/logger";
import { type Metrics, noMetrics, secondsSince } from "../ports/metrics";
import type { PendingReferenceClaim } from "../ports/repositories";
import type { Clock, IdGenerator } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";
import { eventContextFactory } from "./context";
import { outcomeEvents } from "./outcome-events";
import { resolveReference, wakeDependentsOf } from "./references";

/**
 * FAILED: a permanent error while evaluating the item, recorded as FAILED (auditable) so it never
 * blocks the queue. RETRY_LATER: a transient error; the lease expires and a later round retries it
 * without spending an attempt.
 */
export type PendingResolution = "PROCESSED" | "REJECTED" | "FAILED" | "STILL_PENDING" | "SKIPPED" | "RETRY_LATER";

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
  metrics?: Metrics;
  faults?: FaultInjector;
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
 *
 * Each item is isolated: an error never aborts the round. A transient error leaves the item for a
 * later round (its lease expires); any other error marks that item FAILED in its own transaction.
 */
export class ResolvePendingReference {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  async runRound(): Promise<ResolveRoundResult> {
    const claims = await this.claim();
    const resolutions: Record<PendingResolution, number> = {
      PROCESSED: 0,
      REJECTED: 0,
      FAILED: 0,
      STILL_PENDING: 0,
      SKIPPED: 0,
      RETRY_LATER: 0,
    };
    const log = this.deps.logger ?? silentLogger;
    for (const claim of claims) {
      const fields = { transactionId: claim.id, walletId: claim.walletId, correlationId: claim.id };
      let resolution: PendingResolution;
      try {
        resolution = await this.resolve(claim);
      } catch (error) {
        resolution = await this.handleItemError(claim, error, fields);
      }
      resolutions[resolution]++;
      if (resolution === "STILL_PENDING" || resolution === "SKIPPED") log.debug({ ...fields, resolution }, "pending reference evaluated");
      else if (resolution === "PROCESSED" || resolution === "REJECTED") log.info({ ...fields, resolution }, "pending reference resolved");
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
    const metrics = this.deps.metrics ?? noMetrics;
    const startedAt = performance.now();
    const result = await this.evaluate(claim);
    if (result.resolution === "STILL_PENDING") metrics.retry("pending_reference", "REFERENCE_STILL_MISSING");
    if (result.kind && (result.resolution === "PROCESSED" || result.resolution === "REJECTED")) {
      metrics.transactionRecorded(result.kind, result.resolution, "WORKER");
      metrics.processingDuration("WORKER", secondsSince(startedAt));
    }
    return result.resolution;
  }

  private async evaluate(claim: PendingReferenceClaim): Promise<{ resolution: PendingResolution; kind?: string }> {
    const { runner, ids, clock, retryPolicy } = this.deps;
    const metrics = this.deps.metrics ?? noMetrics;
    return runner.run(async (repos) => {
      const lockRequestedAt = performance.now();
      const wallet = await repos.wallets.lockById(claim.walletId);
      metrics.lockWait(secondsSince(lockRequestedAt));
      const tx = await repos.transactions.lockById(claim.id);
      if (!wallet || !tx || tx.status !== Status.PendingReference) return { resolution: "SKIPPED" };
      await (this.deps.faults ?? noFaults).checkpoint("pending:before-apply");

      const now = clock.now();
      const lookup = await resolveReference(repos, tx);
      const expectedVersion = wallet.version;
      const outcome = applyDecision(tx, wallet, decide(tx, wallet, lookup), {
        ledgerEntryId: ids.next(),
        at: now,
        retryPolicy,
      });
      await repos.transactions.update(tx, Status.PendingReference);
      if (outcome.status === Status.PendingReference) return { resolution: "STILL_PENDING", kind: tx.kind };

      const ledgerEntry = outcome.status === Status.Processed ? outcome.ledgerEntry : undefined;
      if (ledgerEntry) {
        await repos.ledger.insert(ledgerEntry);
        await repos.wallets.saveMovement(wallet, expectedVersion);
      }
      const nextContext = eventContextFactory({ correlationId: tx.id, causationId: tx.id, channel: "WORKER" }, ids, clock);
      await repos.outbox.insert(outcomeEvents(tx, wallet, ledgerEntry, nextContext));
      await wakeDependentsOf(repos, tx, now);
      return { resolution: outcome.status === Status.Processed ? "PROCESSED" : "REJECTED", kind: tx.kind };
    });
  }

  private async handleItemError(
    claim: PendingReferenceClaim,
    error: unknown,
    fields: Record<string, unknown>,
  ): Promise<PendingResolution> {
    const log = this.deps.logger ?? silentLogger;
    const metrics = this.deps.metrics ?? noMetrics;
    if (error instanceof TransientInfrastructureError || error instanceof InjectedFaultError) {
      metrics.retry("pending_reference", error instanceof TransientInfrastructureError ? error.reason : "INJECTED_FAULT");
      log.warn({ ...fields, ...describeError(error) }, "pending reference deferred after a transient failure");
      return "RETRY_LATER";
    }
    try {
      const kind = await this.recordFailure(claim);
      if (!kind) return "SKIPPED";
      metrics.transactionRecorded(kind, Status.Failed, "WORKER");
      log.error({ ...fields, ...describeError(error), status: Status.Failed }, "pending reference failed permanently; recorded as FAILED");
      return "FAILED";
    } catch (recordError) {
      log.error({ ...fields, ...describeError(recordError) }, "pending reference could not be recorded as FAILED; retried after the lease");
      return "RETRY_LATER";
    }
  }

  /** Marks the item FAILED (A16) in its own transaction and wakes its dependents (A28). */
  private async recordFailure(claim: PendingReferenceClaim): Promise<string | undefined> {
    const { runner, clock } = this.deps;
    return runner.run(async (repos) => {
      const wallet = await repos.wallets.lockById(claim.walletId);
      const tx = await repos.transactions.lockById(claim.id);
      if (!wallet || !tx || tx.status !== Status.PendingReference) return undefined;
      const now = clock.now();
      tx.fail(FailureCode.InternalInvariantViolation, now);
      await repos.transactions.update(tx, Status.PendingReference);
      await wakeDependentsOf(repos, tx, now);
      return tx.kind;
    });
  }
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message.slice(0, 300) };
  return { errorMessage: String(error).slice(0, 300) };
}
