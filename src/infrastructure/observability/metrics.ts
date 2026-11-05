import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { LockConflictType, Metrics, RetryComponent } from "../../application/ports/metrics";
import type { Channel } from "../../application/use-cases/context";

export interface MetricsSources {
  /** Unpublished outbox messages and the age of the oldest one (global, read from PostgreSQL). */
  outboxLag(): Promise<{ pending: number; oldestPendingAt: Date | undefined }>;
  /** Approximate number of messages in the DLQ (read from SQS). */
  dlqDepth(): Promise<number>;
}

const SCRAPE_TIMEOUT_MS = 2_000;

/**
 * prom-client implementation of the Metrics port, exposed on GET /metrics. One Registry per
 * container (no global state), so several runtimes can live in one process (tests).
 *
 * Gauges that describe shared state (outbox lag, DLQ depth) are computed at scrape time from the
 * database/broker, so any instance reports the same global value.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly transactions: Counter<"kind" | "status" | "channel">;
  private readonly replays: Counter<"channel">;
  private readonly conflicts: Counter<"reason">;
  private readonly inboxDuplicates: Counter<"consumer">;
  private readonly retries: Counter<"component" | "reason">;
  private readonly dlqMessages: Counter<"reason">;
  private readonly lockWaitSeconds: Histogram;
  private readonly lockConflicts: Counter<"type">;
  private readonly processing: Histogram<"channel">;
  private readonly published: Counter;
  private readonly divergences: Counter;

  constructor(sources?: MetricsSources, options: { defaultMetrics?: boolean } = {}) {
    const registers = [this.registry];
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });

    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "Wager transactions by kind, resulting status and entry channel",
      labelNames: ["kind", "status", "channel"],
      registers,
    });
    this.replays = new Counter({
      name: "idempotent_replays_total",
      help: "Requests answered with the stored result of an identical earlier request",
      labelNames: ["channel"],
      registers,
    });
    this.conflicts = new Counter({
      name: "idempotency_conflicts_total",
      help: "Same Idempotency-Key / external id with a different payload (409 / DLQ)",
      labelNames: ["reason"],
      registers,
    });
    this.inboxDuplicates = new Counter({
      name: "inbox_duplicates_total",
      help: "Redelivered messages recognized by the inbox and ignored",
      labelNames: ["consumer"],
      registers,
    });
    this.retries = new Counter({
      name: "retries_total",
      help: "Retries by component (in-place DB retries, SQS redeliveries, outbox and pending-reference reschedules)",
      labelNames: ["component", "reason"],
      registers,
    });
    this.dlqMessages = new Counter({
      name: "dlq_messages_total",
      help: "Messages moved to the dead-letter queue by this process",
      labelNames: ["reason"],
      registers,
    });
    this.lockWaitSeconds = new Histogram({
      name: "wallet_lock_wait_seconds",
      help: "Time waiting for the wallet row lock (SELECT … FOR UPDATE)",
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wallet_lock_conflicts_total",
      help: "Lock contention outcomes: lock_timeout, deadlock, serialization failure, version conflict (A30)",
      labelNames: ["type"],
      registers,
    });
    this.processing = new Histogram({
      name: "wagering_processing_duration_seconds",
      help: "End-to-end processing time of a wager operation by channel",
      labelNames: ["channel"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
    this.published = new Counter({
      name: "outbox_published_total",
      help: "Outbox messages accepted by the broker",
      registers,
    });
    this.divergences = new Counter({
      name: "reconciliation_divergences_total",
      help: "Reconciliations where the stored balance differs from the ledger",
      registers,
    });

    new Gauge({
      name: "outbox_pending",
      help: "Unpublished outbox messages (global)",
      registers,
      async collect() {
        const lag = sources ? await withTimeout(sources.outboxLag()) : undefined;
        if (lag) this.set(lag.pending);
      },
    });
    new Gauge({
      name: "outbox_lag_seconds",
      help: "Age of the oldest unpublished outbox message (0 when fully published)",
      registers,
      async collect() {
        const lag = sources ? await withTimeout(sources.outboxLag()) : undefined;
        if (lag) this.set(lag.oldestPendingAt ? Math.max(0, (Date.now() - lag.oldestPendingAt.getTime()) / 1_000) : 0);
      },
    });
    new Gauge({
      name: "dlq_depth",
      help: "Approximate number of messages in the dead-letter queue",
      registers,
      async collect() {
        const depth = sources ? await withTimeout(sources.dlqDepth()) : undefined;
        if (depth !== undefined) this.set(depth);
      },
    });
  }

  transactionRecorded(kind: string, status: string, channel: Channel): void {
    this.transactions.inc({ kind, status, channel });
  }
  idempotentReplay(channel: Channel): void {
    this.replays.inc({ channel });
  }
  idempotencyConflict(reason: string): void {
    this.conflicts.inc({ reason });
  }
  inboxDuplicate(consumer: string): void {
    this.inboxDuplicates.inc({ consumer });
  }
  retry(component: RetryComponent, reason: string): void {
    this.retries.inc({ component, reason });
  }
  deadLettered(reason: string): void {
    this.dlqMessages.inc({ reason });
  }
  lockWait(seconds: number): void {
    this.lockWaitSeconds.observe(seconds);
  }
  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }
  processingDuration(channel: Channel, seconds: number): void {
    this.processing.observe({ channel }, seconds);
  }
  outboxPublished(count: number): void {
    if (count > 0) this.published.inc(count);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

/** A dependency outage must not hang or fail the scrape: the gauge keeps its previous value. */
async function withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SCRAPE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
