import { ValidationError } from "../../domain/errors";
import { Money, type MoneyProps } from "../../domain/money/money";
import { applyDecision } from "../../domain/wager/apply-decision";
import { decide } from "../../domain/wager/decide";
import { FailureCode } from "../../domain/wager/failure-code";
import { evaluateIdempotency, IdempotencyConflictError } from "../../domain/wager/idempotency";
import { EXTERNAL_KINDS, type WagerTransactionKind, WagerTransactionStatus as Status } from "../../domain/wager/kinds";
import type { ReferenceRetryPolicy } from "../../domain/wager/reference-retry-policy";
import { type CreateWagerTransactionProps, WagerTransaction } from "../../domain/wager/wager-transaction";
import { ApplicationError, NotFoundError, TransientInfrastructureError, UniqueViolationError } from "../errors";
import { wagerPayloadHash } from "../idempotency/payload-hash";
import { type FaultInjector, InjectedFaultError } from "../ports/fault-injector";
import { type Metrics, noMetrics, secondsSince } from "../ports/metrics";
import type { Repositories } from "../ports/repositories";
import type { Clock, IdGenerator } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";
import { eventContextFactory, type RequestContext } from "./context";
import { assertSupportedCurrency } from "./create-wallet";
import { outcomeEvents } from "./outcome-events";
import { resolveReference, wakeDependentsOf } from "./references";

export interface SubmitWagerCommand {
  idempotencyKey: string;
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

export interface SubmitResult {
  transaction: WagerTransaction;
  /** True when an identical request had already been accepted (idempotent replay). */
  replay: boolean;
}

export interface SubmitHooks {
  /** Runs inside the same SQL transaction, before the wager is evaluated (e.g. the inbox insert). */
  withinTransaction?: (repos: Repositories) => Promise<void>;
  /**
   * Errors the caller owns (e.g. the inbox duplicate raised by its own hook): rethrown as-is,
   * never recorded as FAILED.
   */
  passthrough?: (error: unknown) => boolean;
}

export interface SubmitWagerDeps {
  runner: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  faults: FaultInjector;
  retryPolicy: ReferenceRetryPolicy;
  supportedCurrencies: readonly string[];
  metrics?: Metrics;
}

/** Permanent error after the request was accepted (A16). The transaction was recorded as FAILED when possible. */
export class InternalProcessingError extends ApplicationError {
  readonly code = "INTERNAL_ERROR";

  constructor(
    readonly transactionId: string | undefined,
    options?: { cause?: unknown },
  ) {
    super("The transaction could not be processed due to a permanent internal error", options);
  }
}

const IDEMPOTENCY_CONSTRAINTS = new Set(["wager_tx_idempotency_key_uq", "wager_tx_provider_external_uq"]);

type UnitResult = { type: "NEW"; transaction: WagerTransaction } | { type: "EXISTING"; result: SubmitResult };

/**
 * The single entry point for wager submissions, shared by HTTP and SQS (§10).
 *
 * 1. Validate and hash the payload (A14).
 * 2. Fast path: an existing transaction with this key/external id → replay or conflict, without locking.
 * 3. One SQL transaction: lock the wallet row (FOR UPDATE), re-check idempotency, resolve the
 *    reference, decide (§7), persist transaction + ledger + wallet + outbox atomically.
 * 4. A concurrent duplicate that slipped past both checks hits the UNIQUE constraints and is
 *    turned into a replay/conflict by re-reading the winner.
 */
export class SubmitWagerTransaction {
  constructor(private readonly deps: SubmitWagerDeps) {}

  async execute(command: SubmitWagerCommand, ctx: RequestContext, hooks: SubmitHooks = {}): Promise<SubmitResult> {
    const metrics = this.deps.metrics ?? noMetrics;
    const startedAt = performance.now();
    try {
      const result = await this.process(command, ctx, hooks);
      if (result.replay) metrics.idempotentReplay(ctx.channel);
      else metrics.transactionRecorded(result.transaction.kind, result.transaction.status, ctx.channel);
      metrics.processingDuration(ctx.channel, secondsSince(startedAt));
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) metrics.idempotencyConflict(error.code);
      if (error instanceof InternalProcessingError) metrics.transactionRecorded(command.kind, "FAILED", ctx.channel);
      throw error;
    }
  }

  private async process(command: SubmitWagerCommand, ctx: RequestContext, hooks: SubmitHooks): Promise<SubmitResult> {
    const { runner, ids, clock, faults } = this.deps;
    const props = this.buildProps(command);
    const identity = { idempotencyKey: props.idempotencyKey, payloadHash: props.payloadHash };

    if (!hooks.withinTransaction) {
      const existing = await runner.read((repos) => findExisting(repos, props));
      if (existing) return resolveExisting(existing, identity);
    }

    const nextEventContext = eventContextFactory(ctx, ids, clock);
    let result: UnitResult;
    try {
      result = await runner.run(async (repos) => {
        await hooks.withinTransaction?.(repos);
        const lockRequestedAt = performance.now();
        const wallet = await repos.wallets.lockById(props.walletId);
        (this.deps.metrics ?? noMetrics).lockWait(secondsSince(lockRequestedAt));
        if (!wallet) throw new NotFoundError("WALLET", props.walletId);

        // Evaluated inside the transaction: a conflict rolls back whatever the hook wrote (inbox).
        const existing = await findExisting(repos, props);
        if (existing) return { type: "EXISTING", result: resolveExisting(existing, identity) };

        const tx = WagerTransaction.create(props);
        const lookup = tx.hasReference() ? await resolveReference(repos, tx) : undefined;
        const expectedVersion = wallet.version;
        const outcome = applyDecision(tx, wallet, decide(tx, wallet, lookup), {
          ledgerEntryId: ids.next(),
          at: clock.now(),
          retryPolicy: this.deps.retryPolicy,
        });

        await repos.transactions.insert(tx);
        await faults.checkpoint("submit:after-transaction-insert");
        const ledgerEntry = outcome.status === Status.Processed ? outcome.ledgerEntry : undefined;
        if (ledgerEntry) {
          await repos.ledger.insert(ledgerEntry);
          await faults.checkpoint("submit:after-ledger-insert");
          await repos.wallets.saveMovement(wallet, expectedVersion);
        }
        await faults.checkpoint("submit:before-outbox-insert");
        await repos.outbox.insert(outcomeEvents(tx, wallet, ledgerEntry, nextEventContext));
        await wakeDependentsOf(repos, tx, clock.now());
        return { type: "NEW", transaction: tx };
      });
    } catch (error) {
      if (hooks.passthrough?.(error)) throw error;
      if (error instanceof UniqueViolationError && error.constraint && IDEMPOTENCY_CONSTRAINTS.has(error.constraint)) {
        const existing = await runner.read((repos) => findExisting(repos, props));
        if (existing) return resolveExisting(existing, identity);
      }
      if (isUnexpected(error)) {
        const failedId = await this.recordFailure(props);
        throw new InternalProcessingError(failedId, { cause: error });
      }
      throw error;
    }

    if (result.type === "EXISTING") return result.result;
    await faults.checkpoint("submit:after-commit");
    return { transaction: result.transaction, replay: false };
  }

  /** Validates the command up-front so invalid payloads are rejected before touching the database. */
  private buildProps(command: SubmitWagerCommand): CreateWagerTransactionProps {
    const money = Money.from(command.money);
    assertSupportedCurrency(money.currency, this.deps.supportedCurrencies);
    const kind = parseKind(command.kind);
    const payloadHash = wagerPayloadHash({ ...command, money: money.toJSON() });
    const props: CreateWagerTransactionProps = {
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money,
      createdAt: this.deps.clock.now(),
    };
    if (command.referenceExternalTransactionId !== undefined) {
      props.referenceExternalTransactionId = command.referenceExternalTransactionId;
    }
    WagerTransaction.create(props); // structural validation (throws ValidationError)
    return props;
  }

  /** Best effort (A16): record the accepted transaction as FAILED for auditability. */
  private async recordFailure(props: CreateWagerTransactionProps): Promise<string | undefined> {
    try {
      return await this.deps.runner.run(async (repos) => {
        if (!(await repos.wallets.findById(props.walletId))) return undefined;
        if (await findExisting(repos, props)) return undefined;
        const tx = WagerTransaction.create(props);
        tx.fail(FailureCode.InternalInvariantViolation, this.deps.clock.now());
        await repos.transactions.insert(tx);
        return tx.id;
      });
    } catch {
      return undefined;
    }
  }
}

function parseKind(kind: string): WagerTransactionKind {
  const match = EXTERNAL_KINDS.find((candidate) => candidate === kind);
  if (!match) {
    throw new ValidationError(`kind must be one of ${EXTERNAL_KINDS.join(", ")}`, "kind");
  }
  return match;
}

async function findExisting(
  repos: Repositories,
  props: Pick<CreateWagerTransactionProps, "idempotencyKey" | "providerId" | "externalTransactionId">,
): Promise<WagerTransaction | null> {
  return (
    (await repos.transactions.findByIdempotencyKey(props.idempotencyKey)) ??
    (await repos.transactions.findByExternalId(props.providerId, props.externalTransactionId))
  );
}

function resolveExisting(
  existing: WagerTransaction,
  identity: { idempotencyKey: string; payloadHash: string },
): SubmitResult {
  const verdict = evaluateIdempotency(existing, identity);
  if (verdict.type === "CONFLICT") throw new IdempotencyConflictError(verdict.reason, existing.id);
  return { transaction: verdict.transaction, replay: true };
}


/** Errors that are neither expected business/application outcomes nor transient: permanent (A16). */
function isUnexpected(error: unknown): boolean {
  if (error instanceof InjectedFaultError) return false;
  if (error instanceof TransientInfrastructureError) return false;
  if (error instanceof NotFoundError) return false;
  if (error instanceof IdempotencyConflictError) return false;
  if (error instanceof ValidationError) return false;
  return true;
}
