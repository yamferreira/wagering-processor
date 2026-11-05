import { z } from "zod";

const intFromEnv = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().url().default("postgres://wagering:wagering@localhost:55432/wagering"),
  DB_POOL_MAX: intFromEnv(20),
  DB_LOCK_TIMEOUT_MS: intFromEnv(5_000),
  DB_STATEMENT_TIMEOUT_MS: intFromEnv(10_000),
  DB_TX_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  SQS_ENDPOINT: z.string().url().default("http://localhost:4566"),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1).default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default("test"),
  SQS_INPUT_QUEUE: z.string().endsWith(".fifo").default("wager-transactions.fifo"),
  SQS_DLQ: z.string().endsWith(".fifo").default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE: z.string().endsWith(".fifo").default("wagering-events.fifo"),
  /** Broker-side safety net (redrive maxReceiveCount); the consumer gives up earlier (A27). */
  SQS_REDRIVE_MAX_RECEIVES: intFromEnv(6),
  /** Application-side limit: a transient failure on the N-th receive goes to the DLQ (A27). */
  SQS_MAX_RECEIVES: intFromEnv(5),
  SQS_VISIBILITY_TIMEOUT_S: intFromEnv(30),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(20),
  SQS_RETRY_BASE_S: intFromEnv(2),
  SQS_RETRY_CAP_S: intFromEnv(300),
  CONSUMER_CONCURRENCY: intFromEnv(10),
  OUTBOX_BATCH_SIZE: intFromEnv(50),
  OUTBOX_POLL_MS: intFromEnv(200),
  PENDING_REF_BATCH_SIZE: intFromEnv(20),
  PENDING_REF_POLL_MS: intFromEnv(500),
  /** Comma-separated roles of this process (A31): api, consumer, publisher, pending-worker. */
  ROLES: z
    .string()
    .default("api,consumer,publisher,pending-worker")
    .transform((value) =>
      value
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(["api", "consumer", "publisher", "pending-worker"])).min(1)),
  /** How long a graceful stop waits for in-flight work before handing messages back. */
  SHUTDOWN_GRACE_MS: intFromEnv(10_000),
  /** Test-only fault injection (FAULTS=point:action,...); ignored unless set. */
  FAULTS: z.string().default(""),
  SUPPORTED_CURRENCIES: z
    .string()
    .default("BRL,USD,EUR")
    .transform((value) =>
      value
        .split(",")
        .map((currency) => currency.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)),
  PENDING_REF_MAX_ATTEMPTS: intFromEnv(10),
  PENDING_REF_BASE_MS: intFromEnv(2_000),
  PENDING_REF_CAP_MS: intFromEnv(300_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { ...parsed.data, ...overrides };
}
