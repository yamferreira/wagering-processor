import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { silentLogger } from "../../../src/application/ports/logger";
import { buildContainer, type Container } from "../../../src/infrastructure/app/container";
import { loadConfig } from "../../../src/infrastructure/config/config";
import { createHttpApp } from "../../../src/infrastructure/http/http-app";
import { createHttpHarness, type HttpHarness } from "../../support/http";
import { assertLedgerInvariant } from "../../support/invariants";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * T17 — readiness per dependency and transient infrastructure failures surfacing as 503 with
 * Retry-After (§3, §9): the provider can always resend with the same Idempotency-Key.
 */
const UNREACHABLE_SQS = "http://127.0.0.1:1";
const UNREACHABLE_PG = "postgres://wagering:wagering@127.0.0.1:1/wagering";

function walletBody(playerId = `player-${crypto.randomUUID()}`) {
  return { playerId, initialBalance: { amount: "100.00", currency: "BRL" } };
}

function betBody(wallet: { walletId: string; playerId: string }, externalTransactionId = `tx-${crypto.randomUUID()}`) {
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };
}

describe("readiness", () => {
  test("200 when PostgreSQL and SQS are reachable", async () => {
    const h = await createHttpHarness();
    try {
      const ready = await h.request("GET", "/health/ready");
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: "ready", checks: { postgres: { status: "up" }, sqs: { status: "up" } } });
    } finally {
      await assertLedgerInvariant(h.db.sql);
      await h.close();
    }
  });

  test("503 with per-dependency detail when SQS is unreachable; liveness stays 200", async () => {
    const h = await createHttpHarness({ config: { SQS_ENDPOINT: UNREACHABLE_SQS } });
    try {
      const startedAt = Date.now();
      const ready = await h.request("GET", "/health/ready");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(ready.status).toBe(503);
      expect(ready.body.status).toBe("not_ready");
      expect(ready.body.checks.postgres).toEqual({ status: "up" });
      expect(ready.body.checks.sqs.status).toBe("down");
      expect(typeof ready.body.checks.sqs.error).toBe("string");
      expect((await h.request("GET", "/health/live")).status).toBe(200);
      // HTTP processing does not depend on SQS (the outbox absorbs the outage).
      const wallet = await h.request("POST", "/wallets", { body: walletBody() });
      expect(wallet.status).toBe(201);
    } finally {
      await assertLedgerInvariant(h.db.sql);
      await h.close();
    }
  });
});

// No database at all here, so the ledger invariant does not apply.
describe("PostgreSQL unreachable", () => {
  let container: Container;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const config = loadConfig(process.env, { DATABASE_URL: UNREACHABLE_PG, LOG_LEVEL: "silent", DB_POOL_MAX: 2 });
    container = await buildContainer(config, { logger: silentLogger });
    app = await createHttpApp(container);
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
    await container.close();
  });

  test("the process still boots; readiness reports postgres down", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: Record<string, { status: string }> };
    expect(body.checks.postgres?.status).toBe("down");
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });

  test("POST /wagering/transactions → 503 TRANSIENT_INFRASTRUCTURE_ERROR with Retry-After", async () => {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "provider-a:tx-db-down" },
      body: JSON.stringify(betBody({ walletId: crypto.randomUUID(), playerId: "p" }, "tx-db-down")),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    const body = (await response.json()) as { error: { code: string; reason: string } };
    expect(body.error.code).toBe("TRANSIENT_INFRASTRUCTURE_ERROR");
    expect(body.error.reason).toBe("CONNECTION_FAILURE");
  });

  test("every endpoint that touches the database maps the outage to 503 (consistent contract)", async () => {
    const wallet = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(walletBody()),
    });
    expect(wallet.status).toBe(503);
    expect((await fetch(`${baseUrl}/wallets/${crypto.randomUUID()}`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(503);
  });

  test("payload validation still answers 400 without touching the database", async () => {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      body: JSON.stringify({ kind: "BET" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("lock timeout", () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness({ config: { DB_LOCK_TIMEOUT_MS: 300 } });
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql); // §13: the invariant closes every test
  });
  afterAll(async () => {
    await h.close();
  });

  test("a wallet row held longer than lock_timeout → 503 LOCK_TIMEOUT; the same key succeeds once released", async () => {
    const created = await h.request("POST", "/wallets", { body: walletBody() });
    expect(created.status).toBe(201);
    const wallet = { walletId: created.body.id as string, playerId: created.body.playerId as string };

    const holder = await h.db.sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
    const body = betBody(wallet);
    const headers = { "Idempotency-Key": `provider-a:${body.externalTransactionId}` };
    let blocked;
    try {
      blocked = await h.request("POST", "/wagering/transactions", { body, headers });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(blocked.body.error).toMatchObject({ code: "TRANSIENT_INFRASTRUCTURE_ERROR", reason: "LOCK_TIMEOUT" });
    const [none] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(none.n).toBe(0); // nothing was half-written

    const retried = await h.request("POST", "/wagering/transactions", { body, headers });
    expect(retried.status).toBe(201);
    expect(retried.body.balance).toEqual({ amount: "75.00", currency: "BRL" });
  });
});
