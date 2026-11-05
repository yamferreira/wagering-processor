import type { INestApplication } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { createHttpApp } from "../http/http-app";
import { WagerTransactionConsumer } from "../messaging/consumers/wager-transaction.consumer";
import { buildContainer, type Container, type ContainerOverrides } from "./container";

export type Role = AppConfig["ROLES"][number];

export interface Runtime {
  container: Container;
  roles: readonly Role[];
  http?: INestApplication;
  /** Bound HTTP port (when the api role runs). */
  port?: number;
  consumer?: WagerTransactionConsumer;
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
    if (roles.includes("api")) {
      runtime.http = await createHttpApp(container, {
        onUnexpectedError: (error) => log.error({ err: describe(error) }, "unexpected error"),
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
  await runtime.http?.close().catch((error) => log.error({ err: describe(error) }, "http close failed"));
  await runtime.consumer?.stop().catch((error) => log.error({ err: describe(error) }, "consumer stop failed"));
  await runtime.container.close();
  log.info({}, "runtime stopped");
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
