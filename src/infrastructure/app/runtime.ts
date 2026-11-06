import type { INestApplication } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { createHttpApp } from "../http/http-app";
import { WagerTransactionConsumer } from "../messaging/consumers/wager-transaction.consumer";
import { PollingWorker } from "../workers/polling-worker";
import { errorFields } from "../observability/logger";
import { buildContainer, type Container, type ContainerOverrides } from "./container";

export type Role = AppConfig["ROLES"][number];

export interface Runtime {
  container: Container;
  roles: readonly Role[];
  http?: INestApplication;
  /** Bound HTTP port (when the api role runs). */
  port?: number;
  consumer?: WagerTransactionConsumer;
  publisher?: PollingWorker;
  pendingWorker?: PollingWorker;
  /** Graceful shutdown in reverse start order. Idempotent. */
  stop(): Promise<void>;
}

/**
 * One "instance" (A31): the roles listed in ROLES running in this process, sharing one
 * container (connection pool, SQS client). Every role is stateless: any number of instances
 * can run concurrently because all coordination happens in PostgreSQL (row locks, SKIP LOCKED,
 * unique constraints).
 */
export async function startRuntime(config: AppConfig, overrides: ContainerOverrides = {}): Promise<Runtime> {
  const container = await buildContainer(config, overrides);
  const roles = config.ROLES;
  const log = container.logger;
  const runtime: Runtime = { container, roles, stop: async () => {} };

  try {
    if (roles.includes("consumer")) {
      runtime.consumer = new WagerTransactionConsumer(
        {
          input: container.sqs.input,
          dlq: container.sqs.dlq,
          handler: container.handleWagerMessage,
          faults: container.faults,
          logger: log.child({ component: "consumer" }),
          observer: {
            onRetry: (failure) => container.metrics.retry("consumer", failure.code),
            onDeadLetter: (failure) => container.metrics.deadLettered(failure.code),
          },
        },
        {
          concurrency: config.CONSUMER_CONCURRENCY,
          waitTimeSeconds: config.SQS_WAIT_TIME_S,
          maxReceives: config.SQS_MAX_RECEIVES,
          retryBaseSeconds: config.SQS_RETRY_BASE_S,
          retryCapSeconds: config.SQS_RETRY_CAP_S,
          shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
        },
      );
      runtime.consumer.start();
    }
    if (roles.includes("publisher")) {
      const publisherLog = log.child({ component: "outbox-publisher" });
      runtime.publisher = new PollingWorker(
        async () => {
          const result = await container.publishOutbox.execute();
          if (result.claimed > 0) publisherLog.debug({ ...result }, "outbox batch");
          if (result.failed > 0) publisherLog.warn({ ...result }, "outbox publish failures; rescheduled with backoff");
          return { moreWork: result.claimed === config.OUTBOX_BATCH_SIZE };
        },
        { name: "outbox-publisher", idleDelayMs: config.OUTBOX_POLL_MS },
        publisherLog,
      );
      runtime.publisher.start();
    }
    if (roles.includes("pending-worker")) {
      const workerLog = log.child({ component: "pending-reference-worker" });
      runtime.pendingWorker = new PollingWorker(
        async () => {
          const result = await container.resolvePending.runRound();
          if (result.claimed > 0) workerLog.info({ claimed: result.claimed, ...result.resolutions }, "pending references resolved");
          return { moreWork: result.claimed === config.PENDING_REF_BATCH_SIZE };
        },
        { name: "pending-reference-worker", idleDelayMs: config.PENDING_REF_POLL_MS },
        workerLog,
      );
      runtime.pendingWorker.start();
    }
    if (roles.includes("api")) {
      runtime.http = await createHttpApp(container, {
        onUnexpectedError: (error) => log.error({ ...errorFields(error) }, "unexpected error"),
      });
      await runtime.http.listen(config.PORT, "0.0.0.0");
      const address = runtime.http.getHttpServer().address() as { port: number } | null;
      runtime.port = address?.port ?? config.PORT;
      log.info({ port: runtime.port }, "http listening");
    }
  } catch (error) {
    await shutdown(runtime);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  runtime.stop = () => (stopping ??= shutdown(runtime));
  log.info({ roles }, "runtime started");
  return runtime;
}

async function shutdown(runtime: Runtime): Promise<void> {
  const log = runtime.container.logger;
  // Stop accepting HTTP first, then drain message work, then release the pool.
  await runtime.http?.close().catch((error) => log.error({ ...errorFields(error) }, "http close failed"));
  await Promise.all([
    runtime.consumer?.stop().catch((error) => log.error({ ...errorFields(error) }, "consumer stop failed")),
    runtime.publisher?.stop().catch((error) => log.error({ ...errorFields(error) }, "publisher stop failed")),
    runtime.pendingWorker?.stop().catch((error) => log.error({ ...errorFields(error) }, "pending worker stop failed")),
  ]);
  await runtime.container.close();
  log.info({}, "runtime stopped");
}

