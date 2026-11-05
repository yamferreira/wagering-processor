import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ProviderIdentityPort,
  UnauthenticatedError,
} from "../../../src/application/ports/provider-identity.port";
import { createHttpHarness, type HttpHarness } from "../../support/http";
import { assertLedgerInvariant } from "../../support/invariants";
import { walletRow } from "../../support/inspect";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

let h: HttpHarness;

beforeAll(async () => {
  h = await createHttpHarness();
});

beforeEach(() => h.faults.reset());

afterEach(async () => {
  await assertLedgerInvariant(h.db.sql);
});

afterAll(async () => {
  await h.close();
});

const money = (amount: string, currency = "BRL") => ({ amount, currency });
let seq = 0;

async function createWallet(amount = "1000.00") {
  const response = await h.request("POST", "/wallets", {
    body: { playerId: `player-${Bun.randomUUIDv7()}`, initialBalance: money(amount) },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    providerId: "provider-a",
    externalTransactionId: `http-tx-${Date.now()}-${seq}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: money("25.00"),
    ...overrides,
  };
}

const submit = (body: Record<string, unknown>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  h.request("POST", "/wagering/transactions", { body, headers: { "Idempotency-Key": key } });

function expectErrorShape(body: unknown, code?: string) {
  expect(body).toEqual({ error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }) });
  if (code) expect((body as { error: { code: string } }).error.code).toBe(code);
}

describe("POST /wallets", () => {
  test("201 with the §9 response shape", async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;
    const response = await h.request("POST", "/wallets", { body: { playerId, initialBalance: money("1000.00") } });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), playerId, balance: money("1000.00"), version: 1 });
  });

  test("409 for a duplicate player + currency", async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;
    await h.request("POST", "/wallets", { body: { playerId, initialBalance: money("1.00") } });
    const duplicate = await h.request("POST", "/wallets", { body: { playerId, initialBalance: money("2.00") } });
    expect(duplicate.status).toBe(409);
    expectErrorShape(duplicate.body, "WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["amount as a JSON number", { playerId: "p", initialBalance: { amount: 25.5, currency: "BRL" } }, "VALIDATION_ERROR"],
    ["amount without decimals", { playerId: "p", initialBalance: money("10") }, "INVALID_MONEY"],
    ["negative amount", { playerId: "p", initialBalance: money("-1.00") }, "INVALID_MONEY"],
    ["scientific notation", { playerId: "p", initialBalance: money("1e3") }, "INVALID_MONEY"],
    ["unsupported currency", { playerId: "p", initialBalance: money("1.00", "JPY") }, "VALIDATION_ERROR"],
    ["malformed currency", { playerId: "p", initialBalance: money("1.00", "brl") }, "INVALID_CURRENCY"],
    ["unknown field", { playerId: "p", initialBalance: money("1.00"), vip: true }, "VALIDATION_ERROR"],
    ["missing playerId", { initialBalance: money("1.00") }, "VALIDATION_ERROR"],
  ])("400 for %s", async (_label, body, code) => {
    const response = await h.request("POST", "/wallets", { body });
    expect(response.status).toBe(400);
    expectErrorShape(response.body, code);
  });

  test("400 for malformed JSON", async () => {
    const response = await h.request("POST", "/wallets", { raw: "{oops" });
    expect(response.status).toBe(400);
    expectErrorShape(response.body, "MALFORMED_JSON");
  });
});

describe("GET /wallets/:walletId, ledger and reconciliation", () => {
  test("wallet, ledger pages with an opaque cursor, and a consistent reconciliation", async () => {
    const wallet = await createWallet("100.00");
    for (let i = 0; i < 3; i++) await submit(wager(wallet, { money: money("10.00") }));

    const got = await h.request("GET", `/wallets/${wallet.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: money("70.00"), version: 4 });

    const page1 = await h.request("GET", `/wallets/${wallet.id}/ledger?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.walletId).toBe(wallet.id);
    expect(page1.body.items.map((i: { walletVersion: number }) => i.walletVersion)).toEqual([1, 2]);
    expect(page1.body.items[1]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: "DEBIT",
      money: money("10.00"),
      balanceBefore: money("100.00"),
      balanceAfter: money("90.00"),
      walletVersion: 2,
      createdAt: expect.any(String),
    });
    const page2 = await h.request("GET", `/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((i: { walletVersion: number }) => i.walletVersion)).toEqual([3, 4]);
    expect(page2.body.nextCursor).toBeNull();

    const reconciliation = await h.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      walletId: wallet.id,
      storedBalance: money("70.00"),
      calculatedBalance: money("70.00"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 4,
    });
  });

  test("404 for unknown wallets and 400 for malformed ids / queries", async () => {
    const unknown = Bun.randomUUIDv7();
    for (const [method, path] of [
      ["GET", `/wallets/${unknown}`],
      ["GET", `/wallets/${unknown}/ledger`],
      ["POST", `/wallets/${unknown}/reconciliation`],
    ] as const) {
      const response = await h.request(method, path);
      expect(response.status).toBe(404);
      expectErrorShape(response.body, "WALLET_NOT_FOUND");
    }
    const wallet = await createWallet();
    for (const path of [
      "/wallets/not-a-uuid",
      `/wallets/${wallet.id}/ledger?limit=0`,
      `/wallets/${wallet.id}/ledger?limit=201`,
      `/wallets/${wallet.id}/ledger?limit=abc`,
      `/wallets/${wallet.id}/ledger?cursor=%25%25`,
      `/wallets/${wallet.id}/ledger?other=1`,
    ]) {
      const response = await h.request("GET", path);
      expect(response.status).toBe(400);
      expectErrorShape(response.body);
    }
  });
});

describe("POST /wagering/transactions — status matrix", () => {
  test("201 new, 200 replay with the original balance", async () => {
    const wallet = await createWallet("1000.00");
    const body = wager(wallet);
    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: money("975.00"),
      idempotentReplay: false,
    });
    await submit(wager(wallet, { money: money("100.00") }));
    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("202 for a missing reference, replay keeps 202", async () => {
    const wallet = await createWallet();
    const body = wager(wallet, { kind: "REFUND", referenceExternalTransactionId: "bet-that-never-came" });
    const first = await submit(body);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PENDING_REFERENCE",
      balance: null,
      idempotentReplay: false,
    });
    const replay = await submit(body);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("422 for a business rejection with failureCode; replay keeps 422 (A11)", async () => {
    const wallet = await createWallet("10.00");
    const body = wager(wallet, { money: money("10.01") });
    const first = await submit(body);
    expect(first.status).toBe(422);
    expect(first.body).toEqual({
      error: {
        code: "INSUFFICIENT_FUNDS",
        message: expect.any(String),
        providerAction: "GIVE_UP",
        transactionId: expect.any(String),
        status: "REJECTED",
        balance: money("10.00"),
        idempotentReplay: false,
      },
    });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body.error).toEqual({ ...first.body.error, idempotentReplay: true });
  });

  test("409 for the same key with a different payload, and for a reused external id", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    await submit(body);
    const conflict = await submit({ ...body, money: money("25.01") });
    expect(conflict.status).toBe(409);
    expectErrorShape(conflict.body, "IDEMPOTENCY_KEY_REUSED");
    const reused = await submit(body, "a-different-key");
    expect(reused.status).toBe(409);
    expectErrorShape(reused.body, "EXTERNAL_TRANSACTION_CONFLICT");
  });

  test("404 for an unknown wallet (nothing persisted)", async () => {
    const response = await submit(wager({ id: Bun.randomUUIDv7(), playerId: "ghost" }));
    expect(response.status).toBe(404);
    expectErrorShape(response.body, "WALLET_NOT_FOUND");
  });

  test("400 without Idempotency-Key", async () => {
    const wallet = await createWallet();
    const response = await h.request("POST", "/wagering/transactions", { body: wager(wallet) });
    expect(response.status).toBe(400);
    expectErrorShape(response.body, "VALIDATION_ERROR");
  });

  test.each([
    ["amount as a JSON number", { money: { amount: 25, currency: "BRL" } }],
    ["scientific notation", { money: money("1e2") }],
    ["three decimals", { money: money("1.005") }],
    ["OPENING kind", { kind: "OPENING" }],
    ["unknown kind", { kind: "JACKPOT" }],
    ["unknown field", { bonus: "x" }],
    ["reserved provider", { providerId: "internal" }],
    ["REFUND without reference", { kind: "REFUND" }],
    ["BET with reference", { referenceExternalTransactionId: "x" }],
    ["walletId that is not a UUID", { walletId: "wallet-1" }],
    ["unsupported currency", { money: money("1.00", "JPY") }],
    ["blank roundId", { roundId: "" }],
  ])("400 for %s", async (_label, overrides) => {
    const wallet = await createWallet();
    const response = await submit(wager(wallet, overrides));
    expect(response.status).toBe(400);
    expectErrorShape(response.body);
  });

  test("500 for a permanent internal failure, recorded as FAILED and replayed as 500 (A16)", async () => {
    const wallet = await createWallet("100.00");
    const body = wager(wallet);
    h.faults.throwAt("submit:after-ledger-insert", () => new TypeError("simulated bug"));
    const first = await submit(body);
    expect(first.status).toBe(500);
    expectErrorShape(first.body, "INTERNAL_ERROR");
    expect(first.body.error.transactionId).toEqual(expect.any(String));
    const replay = await submit(body);
    expect(replay.status).toBe(500);
    expect(replay.body.error).toMatchObject({ status: "FAILED", failureCode: "INTERNAL_INVARIANT_VIOLATION", idempotentReplay: true });
    expect(await walletRow(h.db.sql, wallet.id)).toEqual({ balance: "100.00", version: 1 });
  });
});

describe("GET transactions", () => {
  test("by id and by provider + external id", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const created = await submit(body);
    const byId = await h.request("GET", `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: created.body.transactionId,
      providerId: "provider-a",
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: money("25.00"),
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: "PROCESSED",
      failureCode: null,
      balance: money("975.00"),
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
    const byExternal = await h.request("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  test("404 / 400", async () => {
    const missing = await h.request("GET", `/wagering/transactions/${Bun.randomUUIDv7()}`);
    expect(missing.status).toBe(404);
    expectErrorShape(missing.body, "TRANSACTION_NOT_FOUND");
    const missingExternal = await h.request("GET", "/providers/provider-a/wagering/transactions/nope");
    expect(missingExternal.status).toBe(404);
    const malformed = await h.request("GET", "/wagering/transactions/not-a-uuid");
    expect(malformed.status).toBe(400);
  });
});

describe("cross-cutting HTTP behaviour", () => {
  test("unknown routes use the same error format", async () => {
    const response = await h.request("GET", "/nope");
    expect(response.status).toBe(404);
    expectErrorShape(response.body, "ROUTE_NOT_FOUND");
  });

  test("correlation id is echoed (or generated)", async () => {
    const echoed = await h.request("GET", "/health/live", { headers: { "X-Correlation-Id": "corr-123" } });
    expect(echoed.headers.get("x-correlation-id")).toBe("corr-123");
    const generated = await h.request("GET", "/health/live");
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("health endpoints", async () => {
    expect((await h.request("GET", "/health/live")).body).toEqual({ status: "ok" });
    const ready = await h.request("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", checks: { postgres: { status: "up" } } });
  });
});

describe("AuthGuard + ProviderIdentityPort extension point", () => {
  test("a restrictive identity port is enforced on business routes while health stays open", async () => {
    const onlyProviderB: ProviderIdentityPort = {
      async resolve({ authorization }) {
        if (authorization !== "Bearer provider-b-token") throw new UnauthenticatedError();
        return { subject: "provider-b", providerIds: ["provider-b"] };
      },
    };
    const secured = await createHttpHarness({ identities: onlyProviderB });
    try {
      expect((await secured.request("GET", "/health/live")).status).toBe(200);
      expect((await secured.request("GET", "/health/ready")).status).toBe(200);

      const anonymous = await secured.request("GET", `/wallets/${Bun.randomUUIDv7()}`);
      expect(anonymous.status).toBe(401);
      expectErrorShape(anonymous.body, "UNAUTHENTICATED");

      const auth = { Authorization: "Bearer provider-b-token" };
      const created = await secured.request("POST", "/wallets", {
        body: { playerId: "p-auth", initialBalance: money("10.00") },
        headers: auth,
      });
      expect(created.status).toBe(201);
      const body = wager(created.body, { providerId: "provider-a" });
      const forbidden = await secured.request("POST", "/wagering/transactions", {
        body,
        headers: { ...auth, "Idempotency-Key": "k-auth" },
      });
      expect(forbidden.status).toBe(403);
      expectErrorShape(forbidden.body, "PROVIDER_FORBIDDEN");
    } finally {
      await secured.close();
    }
  });
});
