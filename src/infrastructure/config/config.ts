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
