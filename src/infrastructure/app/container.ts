import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type FaultInjector, noFaults } from "../../application/ports/fault-injector";
import type { EventPublisher } from "../../application/ports/event-publisher";
import type { Logger } from "../../application/ports/logger";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity.port";
import { type Clock, type IdGenerator, systemClock } from "../../application/ports/system";
import type { TransactionRunner } from "../../application/ports/transaction-runner";
import { CreateWallet } from "../../application/use-cases/create-wallet";
import { HandleWagerMessage } from "../../application/use-cases/handle-wager-message";
import { PublishOutboxBatch } from "../../application/use-cases/publish-outbox-batch";
import { ResolvePendingReference } from "../../application/use-cases/resolve-pending-reference";
import { GetWagerTransaction, GetWallet, GetWalletLedger } from "../../application/use-cases/queries";
import { ReconcileWallet, type ReconciliationObserver } from "../../application/use-cases/reconcile-wallet";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import { ReferenceRetryPolicy } from "../../domain/wager/reference-retry-policy";
import { NoopProviderIdentity } from "../auth/noop-provider-identity";
import type { AppConfig } from "../config/config";
import { EnvFaultInjector } from "../faults/env-fault-injector";
import { uuidV7Generator } from "../ids/uuidv7";
import { WAGER_CONSUMER_NAME } from "../messaging/consumers/wager-transaction.consumer";
import { SqsEventPublisher } from "../messaging/outbox/sqs-event-publisher";
import { normalizeQueueUrl } from "../messaging/sqs/queue-provisioner";
import { createSqsClient, SqsQueue } from "../messaging/sqs/sqs.client";
import { type HealthCheck, readinessChecks } from "../observability/health-checks";
import { createLogger } from "../observability/logger";
import { PromMetrics } from "../observability/metrics";
import type { LockConflictType } from "../../application/ports/metrics";
import { TransientReason } from "../../application/errors";
import { initOrm } from "../persistence/orm";
import { MikroOrmTransactionRunner } from "../persistence/transaction-runner";

export type { HealthCheck } from "../observability/health-checks";

/** Composition root: every use case and adapter, wired once per process. */
export interface MessagingQueues {
  client: SQSClient;
  /** Separate client with a short request timeout: publishing happens while outbox rows are locked. */
  publishClient: SQSClient;
  input: SqsQueue;
  dlq: SqsQueue;
  events: SqsQueue;
}

export interface Container {
  config: AppConfig;
  logger: Logger;
  faults: FaultInjector;
  sqs: MessagingQueues;
  handleWagerMessage: HandleWagerMessage;
  metrics: PromMetrics;
  publishOutbox: PublishOutboxBatch;
  resolvePending: ResolvePendingReference;
  runner: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  identities: ProviderIdentityPort;
  createWallet: CreateWallet;
  submit: SubmitWagerTransaction;
  getWallet: GetWallet;
  getLedger: GetWalletLedger;
  getTransaction: GetWagerTransaction;
  reconcile: ReconcileWallet;
  readiness: HealthCheck[];
  close(): Promise<void>;
}

export interface ContainerOverrides {
  orm?: MikroORM;
  faults?: FaultInjector;
  clock?: Clock;
  identities?: ProviderIdentityPort;
  reconciliationObserver?: ReconciliationObserver;
  logger?: Logger;
  /** Wraps the broker publisher (tests record or sabotage publications). */
  decorateEventPublisher?: (publisher: EventPublisher) => EventPublisher;
}

export async function buildContainer(config: AppConfig, overrides: ContainerOverrides = {}): Promise<Container> {
  const ownsOrm = !overrides.orm;
  const orm = overrides.orm ?? (await initOrm(config.DATABASE_URL, config.DB_POOL_MAX));
  const clock = overrides.clock ?? systemClock;
  const ids = uuidV7Generator;
  const sqs = createQueues(config);
  // Scrape-time sources read the shared state (database / broker), so every instance reports the same value.
  const metrics = new PromMetrics({
    outboxLag: () => runner.read((repos) => repos.outbox.lag()),
    dlqDepth: async () => {
      const depth = await sqs.dlq.approximateDepth();
      return depth.visible + depth.inFlight + depth.delayed;
    },
  });
  const runner = new MikroOrmTransactionRunner(
    orm,
    clock,
    {
      lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
      maxRetries: config.DB_TX_MAX_RETRIES,
    },
    {
      onRetry: (reason) => {
        metrics.retry("db_transaction", reason);
        recordLockConflict(metrics, reason);
      },
      onTransientFailure: (reason) => recordLockConflict(metrics, reason),
    },
  );
  const retryPolicy = ReferenceRetryPolicy.of({
    maxAttempts: config.PENDING_REF_MAX_ATTEMPTS,
    baseDelayMs: config.PENDING_REF_BASE_MS,
    maxDelayMs: config.PENDING_REF_CAP_MS,
  });
  const supportedCurrencies = config.SUPPORTED_CURRENCIES;
  const faults = overrides.faults ?? (config.FAULTS ? new EnvFaultInjector(config.FAULTS) : noFaults);
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL });
  const submit = new SubmitWagerTransaction({ runner, ids, clock, faults, retryPolicy, supportedCurrencies, metrics });
  const basePublisher = new SqsEventPublisher(sqs.events);
  const eventPublisher = overrides.decorateEventPublisher?.(basePublisher) ?? basePublisher;

  return {
    config,
    logger,
    faults,
    sqs,
    metrics,
    runner,
    ids,
    clock,
    identities: overrides.identities ?? new NoopProviderIdentity(),
    createWallet: new CreateWallet({ runner, ids, clock, supportedCurrencies, metrics }),
    submit,
    handleWagerMessage: new HandleWagerMessage({ consumerName: WAGER_CONSUMER_NAME, submit, runner, clock, faults, metrics }),
    resolvePending: new ResolvePendingReference({
      runner,
      ids,
      clock,
      retryPolicy,
      batchSize: config.PENDING_REF_BATCH_SIZE,
      leaseMs: config.PENDING_REF_LEASE_MS,
      metrics,
      logger: logger.child({ component: "pending-reference-worker" }),
    }),
    publishOutbox: new PublishOutboxBatch({
      runner,
      publisher: eventPublisher,
      clock,
      faults,
      batchSize: config.OUTBOX_BATCH_SIZE,
      metrics,
    }),
    getWallet: new GetWallet(runner),
    getLedger: new GetWalletLedger(runner),
    getTransaction: new GetWagerTransaction(runner),
    // §9: divergences are never corrected silently — logged (identifiers only), counted and returned.
    reconcile: new ReconcileWallet(runner, {
      onDivergence: (report) => {
        logger.error(
          {
            component: "reconciliation",
            walletId: report.walletId,
            checkedEntries: report.checkedEntries,
            ledgerSumMatches: report.storedBalance.equals(report.calculatedBalance),
            ...report.details,
          },
          "reconciliation divergence: stored balance does not match the ledger",
        );
        metrics.reconciliationDivergence();
        overrides.reconciliationObserver?.onDivergence(report);
      },
    }),
    readiness: readinessChecks({ orm, input: sqs.input }),
    async close() {
      sqs.client.destroy();
      sqs.publishClient.destroy();
      if (ownsOrm) await orm.close(true);
    },
  };
}

/** Queues are resolved by name on first use, so the process boots even while SQS is down. */
function createQueues(config: AppConfig): MessagingQueues {
  const client = createSqsClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    requestTimeoutMs: (config.SQS_WAIT_TIME_S + 10) * 1_000,
  });
  const publishClient = createSqsClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    requestTimeoutMs: 5_000,
  });
  const byName = (name: string) => async () => {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} not found`);
    return normalizeQueueUrl(config.SQS_ENDPOINT, QueueUrl);
  };
  return {
    client,
    publishClient,
    input: new SqsQueue(client, byName(config.SQS_INPUT_QUEUE)),
    dlq: new SqsQueue(client, byName(config.SQS_DLQ)),
    events: new SqsQueue(publishClient, byName(config.SQS_EVENTS_QUEUE)),
  };
}

const LOCK_CONFLICTS: Partial<Record<string, LockConflictType>> = {
  [TransientReason.LockTimeout]: "lock_timeout",
  [TransientReason.Deadlock]: "deadlock",
  [TransientReason.SerializationFailure]: "serialization",
  [TransientReason.ConcurrencyConflict]: "version_conflict",
};

function recordLockConflict(metrics: PromMetrics, reason: string): void {
  const type = LOCK_CONFLICTS[reason];
  if (type) metrics.lockConflict(type);
}
