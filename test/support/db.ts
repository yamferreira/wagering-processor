import { SQL } from "bun";
import { loadConfig } from "../../src/infrastructure/config/config";
import { runMigrations } from "../../src/infrastructure/persistence/migrate";

/**
 * Test database isolation: one migrated template per test process, cloned into a fresh
 * database per test file (CREATE DATABASE … TEMPLATE). Real PostgreSQL, no mocks.
 */
const BASE_URL = loadConfig().DATABASE_URL;
const PREFIX = "wagering_test_";
const TEMPLATE = `${PREFIX}tpl_${process.pid}`;

export function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function adminConnection(): SQL {
  return new SQL({ url: databaseUrl("postgres"), max: 1 });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function dropStaleDatabases(admin: SQL): Promise<void> {
  const rows: { datname: string }[] = await admin.unsafe(
    `SELECT datname FROM pg_database WHERE datname LIKE '${PREFIX}%'`,
  );
  for (const { datname } of rows) {
    const pid = Number(/_(\d+)(?:_|$)/.exec(datname.slice(PREFIX.length))?.[1]);
    if (Number.isFinite(pid) && pid !== process.pid && pidIsAlive(pid)) continue;
    if (pid === process.pid && datname !== TEMPLATE) continue;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}

let templateReady: Promise<void> | undefined;

function ensureTemplate(): Promise<void> {
  templateReady ??= (async () => {
    const admin = adminConnection();
    try {
      await dropStaleDatabases(admin);
      await admin.unsafe(`CREATE DATABASE "${TEMPLATE}"`);
    } finally {
      await admin.close();
    }
    await runMigrations(databaseUrl(TEMPLATE), "up");
  })();
  return templateReady;
}

export interface TestDatabase {
  name: string;
  url: string;
  /** Raw SQL client (Bun.SQL) for fixtures and assertions. */
  sql: SQL;
  drop(): Promise<void>;
}

let counter = 0;

export async function createTestDatabase(): Promise<TestDatabase> {
  await ensureTemplate();
  counter += 1;
  const name = `${PREFIX}${process.pid}_${counter}_${Date.now().toString(36)}`;
  const admin = adminConnection();
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE}"`);
  } finally {
    await admin.close();
  }
  const url = databaseUrl(name);
  const sql = new SQL({ url, max: 10 });
  return {
    name,
    url,
    sql,
    async drop() {
      await sql.close();
      const dropper = adminConnection();
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}

/** Creates an empty database (no migrations) for migration tests. */
export async function createEmptyDatabase(): Promise<TestDatabase> {
  counter += 1;
  const name = `${PREFIX}${process.pid}_${counter}_empty`;
  const admin = adminConnection();
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }
  const url = databaseUrl(name);
  const sql = new SQL({ url, max: 2 });
  return {
    name,
    url,
    sql,
    async drop() {
      await sql.close();
      const dropper = adminConnection();
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}

/** SQLSTATE of a PostgreSQL error raised through Bun.SQL (or the pg driver). */
export function sqlState(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const e = error as { errno?: unknown; code?: unknown };
    if (typeof e.errno === "string") return e.errno;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return undefined;
}

/** Runs `fn` and returns the SQLSTATE it failed with (fails the test if it succeeds). */
export async function expectSqlError(fn: () => Promise<unknown>): Promise<{ state: string | undefined; error: unknown }> {
  try {
    await fn();
  } catch (error) {
    return { state: sqlState(error), error };
  }
  throw new Error("Expected the statement to fail, but it succeeded");
}
