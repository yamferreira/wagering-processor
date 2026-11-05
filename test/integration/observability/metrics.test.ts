import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TransientInfrastructureError, TransientReason } from "../../../src/application/errors";
import { silentLogger } from "../../../src/application/ports/logger";
import type { Runtime } from "../../../src/infrastructure/app/runtime";
import { createMessagingHarness, type MessagingHarness, sendEnvelope, wagerEnvelope } from "../../support/messaging";
import { wagerCommand } from "../../support/use-cases";
import { waitFor } from "../../support/wait";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/** T22 — §12 metrics on GET /metrics, checked after a scripted sequence of operations. */
type Labels = Record<string, string>;

function parse(text: string): { name: string; labels: Labels; value: number }[] {
  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line)!;
      const labels: Labels = {};
      for (const pair of (match[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)) labels[pair[1]!] = pair[2]!;
      return { name: match[1]!, labels, value: Number(match[3]) };
    });
}

describe("GET /metrics", () => {
  let h: MessagingHarness;
  let runtime: Runtime;
  let base: string;

  const scrape = async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    return { text, samples: parse(text) };
  };
  const value = (samples: ReturnType<typeof parse>, name: string, labels: Labels = {}) =>
    samples
      .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
      .reduce((sum, s) => sum + s.value, 0);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const submit = (command: ReturnType<typeof wagerCommand>) => {
    const { idempotencyKey, ...body } = command;
    return post("/wagering/transactions", body, { "Idempotency-Key": idempotencyKey });
  };

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "metrics" });
    runtime = await h.start(
      { ROLES: ["api", "consumer", "publisher", "pending-worker"], DB_LOCK_TIMEOUT_MS: 300 },
      { logger: silentLogger },
    );
    base = `http://127.0.0.1:${runtime.port}`;
  });
  afterAll(async () => {
    await h.close();
  });

  test("every §12 metric is exposed and moves with the operations that should move it", async () => {
    const created = await post("/wallets", { playerId: `m-${crypto.randomUUID()}`, initialBalance: { amount: "100.00", currency: "BRL" } });
    const wallet = (await created.json()) as { id: string; playerId: string };

    const bet = wagerCommand(wallet, { money: { amount: "10.00", currency: "BRL" } });
    expect((await submit(bet)).status).toBe(201);
    expect((await submit(bet)).status).toBe(200); // replay
    expect((await submit({ ...bet, money: { amount: "11.00", currency: "BRL" } })).status).toBe(409); // conflict
    expect((await submit(wagerCommand(wallet, { money: { amount: "999.00", currency: "BRL" } }))).status).toBe(422);

    // PENDING_REFERENCE resolved by the worker.
    const late = wagerCommand(wallet, { roundId: "r-late", money: { amount: "5.00", currency: "BRL" } });
    const rollback = wagerCommand(wallet, {
      kind: "ROLLBACK",
      roundId: "r-late",
      referenceExternalTransactionId: late.externalTransactionId,
      money: { amount: "5.00", currency: "BRL" },
    });
    expect((await submit(rollback)).status).toBe(202);
    expect((await submit(late)).status).toBe(201);

    // SQS: one message delivered twice (inbox duplicate), one transient failure, one invalid envelope.
    h.faults.throwAt("consumer:after-inbox-insert", () => new TransientInfrastructureError(TransientReason.ConnectionFailure, "x"), 1);
    const viaQueue = wagerEnvelope(wagerCommand(wallet, { money: { amount: "1.00", currency: "BRL" } }));
    await sendEnvelope(h.queues, viaQueue);
    await sendEnvelope(h.queues, {}, { raw: "not json", groupId: "bad" });
    await waitFor(async () => {
      const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = ${viaQueue.messageId}`;
      return row.n === 1;
    }, { description: "queued BET applied after one retry", timeoutMs: 20_000 });
    await sendEnvelope(h.queues, viaQueue, { groupId: "dup" });

    // Lock timeout: hold the wallet row longer than DB_LOCK_TIMEOUT_MS (300 ms).
    const holder = await h.db.sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
    try {
      expect((await submit(wagerCommand(wallet, { money: { amount: "1.00", currency: "BRL" } }))).status).toBe(503);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }

    const { text, samples } = await waitFor(async () => {
      const scraped = await scrape();
      const ready =
        value(scraped.samples, "wagering_transactions_total", { kind: "ROLLBACK", status: "PROCESSED", channel: "WORKER" }) >= 1 &&
        value(scraped.samples, "inbox_duplicates_total") >= 1 &&
        value(scraped.samples, "outbox_pending") === 0;
      return ready ? scraped : undefined;
    }, { description: "metrics settled", timeoutMs: 20_000, intervalMs: 250 });

    for (const name of [
      "wagering_transactions_total",
      "idempotent_replays_total",
      "idempotency_conflicts_total",
      "inbox_duplicates_total",
      "retries_total",
      "dlq_messages_total",
      "dlq_depth",
      "wallet_lock_wait_seconds",
      "wallet_lock_conflicts_total",
      "outbox_lag_seconds",
      "outbox_pending",
      "outbox_published_total",
      "wagering_processing_duration_seconds",
      "reconciliation_divergences_total",
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }

    expect(value(samples, "wagering_transactions_total", { kind: "OPENING", status: "PROCESSED", channel: "HTTP" })).toBe(1);
    expect(value(samples, "wagering_transactions_total", { kind: "BET", status: "PROCESSED", channel: "HTTP" })).toBe(2);
    expect(value(samples, "wagering_transactions_total", { kind: "BET", status: "REJECTED", channel: "HTTP" })).toBe(1);
    expect(value(samples, "wagering_transactions_total", { kind: "ROLLBACK", status: "PENDING_REFERENCE", channel: "HTTP" })).toBe(1);
    expect(value(samples, "wagering_transactions_total", { kind: "ROLLBACK", status: "PROCESSED", channel: "WORKER" })).toBe(1);
    expect(value(samples, "wagering_transactions_total", { kind: "BET", status: "PROCESSED", channel: "SQS" })).toBe(1);
    expect(value(samples, "idempotent_replays_total", { channel: "HTTP" })).toBe(1);
    expect(value(samples, "idempotency_conflicts_total", { reason: "IDEMPOTENCY_KEY_REUSED" })).toBe(1);
    expect(value(samples, "inbox_duplicates_total")).toBe(1);
    expect(value(samples, "retries_total", { component: "consumer", reason: "CONNECTION_FAILURE" })).toBe(1);
    expect(value(samples, "dlq_messages_total", { reason: "INVALID_ENVELOPE" })).toBe(1);
    expect(value(samples, "dlq_depth")).toBeGreaterThanOrEqual(1);
    expect(value(samples, "wallet_lock_conflicts_total", { type: "lock_timeout" })).toBe(1);
    expect(value(samples, "wallet_lock_wait_seconds_count")).toBeGreaterThanOrEqual(5);
    expect(value(samples, "wallet_lock_wait_seconds_sum")).toBeGreaterThan(0);
    expect(value(samples, "wagering_processing_duration_seconds_count", { channel: "HTTP" })).toBeGreaterThanOrEqual(5);
    expect(value(samples, "wagering_processing_duration_seconds_count", { channel: "SQS" })).toBeGreaterThanOrEqual(1);
    expect(value(samples, "wagering_processing_duration_seconds_count", { channel: "WORKER" })).toBe(1);
    expect(value(samples, "outbox_published_total")).toBeGreaterThanOrEqual(8);
    expect(value(samples, "outbox_pending")).toBe(0);
    expect(value(samples, "outbox_lag_seconds")).toBe(0);
    expect(value(samples, "reconciliation_divergences_total")).toBe(0);
    expect(text).toContain("process_cpu_user_seconds_total"); // default process metrics
  });
});
