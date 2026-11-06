import { SQL } from "bun";
import { loadConfig } from "../../src/infrastructure/config/config";

/**
 * Fail-fast check of the real infrastructure the integration and concurrency suites need. Runs once per
 * test process, on the first test database or queue it creates (unit tests never reach it). When
 * PostgreSQL or LocalStack is unreachable it prints one actionable message and ends the run, instead
 * of letting every test file fail with its own connection error.
 */
let check: Promise<void> | undefined;

export function ensureTestInfrastructure(): Promise<void> {
  check ??= run();
  return check;
}

const TIMEOUT_MS = 3_000;

async function run(): Promise<void> {
  const config = loadConfig();
  const [postgres, localstack] = await Promise.all([
    probe(() => probePostgres(config.MIGRATION_DATABASE_URL)),
    probe(() => probeLocalStack(config.SQS_ENDPOINT)),
  ]);
  const problems = [
    ...(postgres ? [`PostgreSQL em ${hostOf(config.MIGRATION_DATABASE_URL)}: ${postgres}`] : []),
    ...(localstack ? [`LocalStack (SQS) em ${hostOf(config.SQS_ENDPOINT)}: ${localstack}`] : []),
  ];
  if (problems.length === 0) return;
  console.error(
    [
      "",
      "Infraestrutura de teste indisponível:",
      ...problems.map((problem) => `  - ${problem}`),
      "",
      "Os testes de integração e de concorrência usam PostgreSQL e LocalStack reais.",
      "Suba os dois com: docker compose up -d --wait",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/** Resolves to undefined when reachable, or to a short reason. */
async function probe(fn: () => Promise<void>): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sem resposta em ${TIMEOUT_MS / 1_000}s`)), TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}

async function probePostgres(url: string): Promise<void> {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = new SQL({ url: admin.toString(), max: 1, connectionTimeout: TIMEOUT_MS / 1_000 });
  try {
    await sql`SELECT 1`;
  } finally {
    await sql.close().catch(() => {});
  }
}

async function probeLocalStack(endpoint: string): Promise<void> {
  const response = await fetch(new URL("/_localstack/health", endpoint), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const health = (await response.json()) as { services?: Record<string, string> };
  const sqs = health.services?.sqs;
  if (sqs !== "available" && sqs !== "running") throw new Error(`SQS ${sqs ?? "ausente"}`);
}

function hostOf(url: string): string {
  return new URL(url).host;
}
