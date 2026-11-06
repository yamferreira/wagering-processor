import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TransientInfrastructureError, TransientReason } from "../../../src/application/errors";
import { type FaultPoint, InjectedFaultError } from "../../../src/application/ports/fault-injector";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { assertLedgerInvariant } from "../../support/invariants";
import { jsonLogs, killAllInstances, spawnInstance } from "../../support/instances";
import { createMessagingHarness, type MessagingHarness, sendEnvelope, wagerEnvelope } from "../../support/messaging";
import type { ReceivedMessage } from "../../../src/infrastructure/messaging/sqs/sqs.client";
import { wagerCommand } from "../../support/use-cases";
import { waitFor } from "../../support/wait";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * T14 — SQS consumer against real LocalStack queues and a real PostgreSQL database.
 * Input queue visibility is 3 s so "abandoned" messages (simulated crashes) come back quickly.
 */
async function txRow(h: MessagingHarness, providerId: string, externalId: string) {
  const [row] = await h.db.sql`
    SELECT id, status, failure_code, kind FROM wager_transactions
     WHERE provider_id = ${providerId} AND external_transaction_id = ${externalId}`;
  return row as { id: string; status: string; failure_code: string | null; kind: string } | undefined;
}

async function count(h: MessagingHarness, table: string, where: string): Promise<number> {
  const [row] = await h.db.sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`);
  return row.n;
}

async function balance(h: MessagingHarness, walletId: string): Promise<string> {
  const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return row.balance;
}

/** Waits for `expected` dead letters whose body matches; every DLQ message read is deleted. */
async function deadLetters(h: MessagingHarness, matches: (body: string) => boolean, expected = 1): Promise<ReceivedMessage[]> {
  const found: ReceivedMessage[] = [];
  await waitFor(
    async () => {
      for (const message of await h.queues.dlq.receive({ max: 10, waitSeconds: 1 })) {
        await h.queues.dlq.delete(message.receiptHandle);
        if (matches(message.body)) found.push(message);
      }
      return found.length >= expected;
    },
    { description: `${expected} dead letter(s)`, timeoutMs: 30_000, intervalMs: 0 },
  );
  return found;
}

async function queueIsEmpty(h: MessagingHarness): Promise<boolean> {
  const depth = await h.queues.input.approximateDepth();
  return depth.visible + depth.inFlight + depth.delayed === 0;
}

describe("WagerTransactionRequested consumer (in-process, real LocalStack + PostgreSQL)", () => {
  let h: MessagingHarness;
  let wallet: Wallet;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "consumer", queues: { visibilityTimeoutSeconds: 3, redriveMaxReceives: 6 } });
    await h.start();
  });
  afterEach(async () => {
    h.faults.reset();
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await h.close();
  });

  test("happy path: BET is processed, the inbox row is written and the message is acked", async () => {
    wallet = await h.openWallet("100.00");
    const command = wagerCommand(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope);

    const row = await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });
    expect(row.status).toBe("PROCESSED");
    expect(await balance(h, wallet.id)).toBe("75.00");
    expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}' AND processed_at IS NOT NULL`)).toBe(1);
    expect(await count(h, "outbox_messages", `aggregate_id = '${row.id}'`)).toBeGreaterThanOrEqual(1);
    await waitFor(() => queueIsEmpty(h), { description: "input queue empty" });
    expect(await h.queues.dlq.receive({ waitSeconds: 0 })).toHaveLength(0);
  });

  test("the same messageId delivered many times (also concurrently, distinct groups) has a single effect", async () => {
    const w = await h.openWallet("100.00");
    const command = wagerCommand(w, { money: { amount: "10.00", currency: "BRL" } });
    const envelope = wagerEnvelope(command);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => sendEnvelope(h.queues, envelope, { groupId: `dup-${i}-${crypto.randomUUID()}` })),
    );
    await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });
    await waitFor(() => queueIsEmpty(h), { description: "all copies acked" });

    expect(await count(h, "wager_transactions", `wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(1);
    expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(1);
    expect(await balance(h, w.id)).toBe("90.00");
    expect(await h.queues.dlq.receive({ waitSeconds: 0 })).toHaveLength(0);
  });

  test("different messageIds with the same Idempotency-Key are an idempotent replay (one effect, both inboxed)", async () => {
    const w = await h.openWallet("100.00");
    const command = wagerCommand(w, { money: { amount: "30.00", currency: "BRL" } });
    const first = wagerEnvelope(command);
    const second = wagerEnvelope(command);
    await sendEnvelope(h.queues, first);
    await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });
    await sendEnvelope(h.queues, second);
    await waitFor(async () => (await count(h, "inbox_messages", `message_id = '${second.messageId}'`)) === 1, {
      description: "second inboxed",
    });
    await waitFor(() => queueIsEmpty(h), { description: "acked" });

    expect(await count(h, "wager_transactions", `wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(1);
    expect(await balance(h, w.id)).toBe("70.00");
  });

  test("business rejection is terminal: REJECTED, acked, nothing in the DLQ", async () => {
    const w = await h.openWallet("10.00");
    const command = wagerCommand(w, { money: { amount: "50.00", currency: "BRL" } });
    await sendEnvelope(h.queues, wagerEnvelope(command));
    const row = await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });
    expect(row.status).toBe("REJECTED");
    expect(row.failure_code).toBe("INSUFFICIENT_FUNDS");
    await waitFor(() => queueIsEmpty(h), { description: "acked" });
    expect(await h.queues.dlq.receive({ waitSeconds: 0 })).toHaveLength(0);
    expect(await balance(h, w.id)).toBe("10.00");
  });

  test("unknown wallet (A9) is terminal: inboxed and acked, no transaction row", async () => {
    const ghost = { id: crypto.randomUUID(), playerId: "nobody" };
    const command = wagerCommand(ghost);
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope, { groupId: "ghost" });
    await waitFor(async () => (await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)) === 1, {
      description: "inboxed",
    });
    await waitFor(() => queueIsEmpty(h), { description: "acked" });
    expect(await txRow(h, command.providerId, command.externalTransactionId)).toBeUndefined();
    expect(await h.queues.dlq.receive({ waitSeconds: 0 })).toHaveLength(0);
  });

  test("transient failure injected twice: the message comes back after the visibility backoff and is applied once", async () => {
    const w = await h.openWallet("100.00");
    h.faults.throwAt(
      "consumer:after-inbox-insert",
      () => new TransientInfrastructureError(TransientReason.ConnectionFailure, "injected"),
      2,
    );
    const command = wagerCommand(w, { money: { amount: "5.00", currency: "BRL" } });
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope);

    const row = await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), {
      description: "tx after retries",
      timeoutMs: 20_000,
    });
    expect(row.status).toBe("PROCESSED");
    expect(h.faults.hits.filter((p) => p === "consumer:after-inbox-insert")).toHaveLength(3);
    await waitFor(() => queueIsEmpty(h), { description: "acked" });
    expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(1);
    expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    expect(await balance(h, w.id)).toBe("95.00");
  });

  test("transient failure on every attempt: moved to the DLQ after SQS_MAX_RECEIVES receives, nothing committed", async () => {
    const w = await h.openWallet("100.00");
    h.faults.throwAt(
      "consumer:after-inbox-insert",
      () => new TransientInfrastructureError(TransientReason.ConnectionFailure, "injected"),
      1_000,
    );
    const command = wagerCommand(w);
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope);

    const [dead] = await deadLetters(h, (body) => body.includes(envelope.messageId));
    expect(JSON.parse(dead!.body).messageId).toBe(envelope.messageId);
    expect(dead!.attributes.failureCode).toBe("CONNECTION_FAILURE");
    expect(dead!.attributes.receiveCount).toBe(String(h.config.SQS_MAX_RECEIVES));
    expect(h.faults.hits.filter((p) => p === "consumer:after-inbox-insert")).toHaveLength(h.config.SQS_MAX_RECEIVES);
    expect(await txRow(h, command.providerId, command.externalTransactionId)).toBeUndefined();
    expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(0);
    await waitFor(() => queueIsEmpty(h), { description: "removed from input" });
  });

  test("invalid envelopes go straight to the DLQ (no retries, nothing persisted)", async () => {
    const w = await h.openWallet("100.00");
    const invalid = wagerEnvelope(wagerCommand(w, { money: { amount: "25", currency: "BRL" } }));
    const unknownField = { ...wagerEnvelope(wagerCommand(w)), extra: true };
    await sendEnvelope(h.queues, {}, { raw: "{not json", groupId: "bad-json" });
    await sendEnvelope(h.queues, unknownField, { groupId: "bad-schema" });
    await sendEnvelope(h.queues, invalid, { groupId: "bad-money" });

    const ids = [invalid.messageId, unknownField.messageId];
    const dead = await deadLetters(h, (body) => body === "{not json" || ids.some((id) => body.includes(id)), 3);
    expect(dead.map((m) => m.body)).toContain("{not json");
    expect(dead.every((m) => m.attributes.failureAction === "DLQ" && m.receiveCount === 1)).toBe(true);
    expect(dead.map((m) => m.attributes.failureCode).sort()).toEqual(["INVALID_ENVELOPE", "INVALID_ENVELOPE", "INVALID_MONEY"]);
    expect(await count(h, "inbox_messages", `message_id IN ('${invalid.messageId}', '${unknownField.messageId}')`)).toBe(0);
    expect(await count(h, "wager_transactions", `wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(0);
  });

  test("same Idempotency-Key with a different payload is permanent: DLQ, and its inbox row is rolled back", async () => {
    const w = await h.openWallet("100.00");
    const command = wagerCommand(w, { money: { amount: "10.00", currency: "BRL" } });
    await sendEnvelope(h.queues, wagerEnvelope(command));
    await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });

    const tampered = wagerEnvelope({ ...command, money: { amount: "99.00", currency: "BRL" } });
    await sendEnvelope(h.queues, tampered);
    const [dead] = await deadLetters(h, (body) => body.includes(tampered.messageId));
    expect(dead!.attributes.failureCode).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await count(h, "inbox_messages", `message_id = '${tampered.messageId}'`)).toBe(0);
    expect(await balance(h, w.id)).toBe("90.00");
  });

  test("same messageId with a different payload is permanent (MESSAGE_ID_CONFLICT)", async () => {
    const w = await h.openWallet("100.00");
    const command = wagerCommand(w, { money: { amount: "10.00", currency: "BRL" } });
    const original = wagerEnvelope(command);
    await sendEnvelope(h.queues, original);
    await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "tx" });

    const reused = wagerEnvelope(wagerCommand(w), { messageId: original.messageId });
    await sendEnvelope(h.queues, reused);
    const [dead] = await deadLetters(h, (body) => body.includes(reused.data.externalTransactionId));
    expect(dead!.attributes.failureCode).toBe("MESSAGE_ID_CONFLICT");
    expect(await count(h, "wager_transactions", `wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(1);
  });

  // §11/§13: inbox, wager, ledger, wallet and outbox commit together or not at all — including when the
  // crash happens AFTER the financial writes (ledger + wallet already written inside the transaction).
  test.each([
    ["right after the inbox insert", "consumer:after-inbox-insert"],
    ["after the ledger entry was written", "submit:after-ledger-insert"],
    ["after ledger + wallet, right before the outbox insert", "submit:before-outbox-insert"],
  ] as [string, FaultPoint][])(
    "atomicity: a crash %s commits nothing; the redelivery applies it exactly once",
    async (_label, point) => {
      const w = await h.openWallet("100.00");
      const outboxBefore = await count(h, "outbox_messages", `aggregate_id = '${w.id}'`);
      h.faults.throwAt(point, () => new InjectedFaultError(point), 1);
      const command = wagerCommand(w, { money: { amount: "40.00", currency: "BRL" } });
      const envelope = wagerEnvelope(command);
      await sendEnvelope(h.queues, envelope);

      await waitFor(() => h.faults.hits.includes(point), { description: "fault hit" });
      // Rolled back as a unit: no inbox, no transaction, no ledger entry, no outbox, balance and version untouched.
      expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(0);
      expect(await txRow(h, command.providerId, command.externalTransactionId)).toBeUndefined();
      expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}'`)).toBe(1); // only the OPENING
      expect(await count(h, "outbox_messages", `aggregate_id = '${w.id}'`)).toBe(outboxBefore);
      const [wallet] = await h.db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${w.id}`;
      expect(wallet).toEqual({ balance: "100.00", version: 1 });

      const row = await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), {
        description: "redelivered and applied",
        timeoutMs: 20_000,
      });
      expect(row.status).toBe("PROCESSED");
      await waitFor(() => queueIsEmpty(h), { description: "acked" });
      expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(1);
      expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
      expect(await count(h, "outbox_messages", `aggregate_id = '${row.id}'`)).toBeGreaterThanOrEqual(1);
      expect(await balance(h, w.id)).toBe("60.00");
    },
  );

  test("crash after commit and before ack: the redelivery is deduplicated by the inbox and then acked", async () => {
    const w = await h.openWallet("100.00");
    h.faults.throwAt("consumer:after-commit-before-ack", () => new InjectedFaultError("consumer:after-commit-before-ack"), 1);
    const command = wagerCommand(w, { money: { amount: "15.00", currency: "BRL" } });
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope);

    await waitFor(() => h.faults.hits.includes("consumer:after-commit-before-ack"), { description: "fault hit" });
    expect((await txRow(h, command.providerId, command.externalTransactionId))?.status).toBe("PROCESSED");
    await waitFor(
      async () => h.faults.hits.filter((p) => p === "consumer:after-commit-before-ack").length >= 2 && (await queueIsEmpty(h)),
      { description: "redelivered and acked", timeoutMs: 20_000 },
    );
    expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    expect(await balance(h, w.id)).toBe("85.00");
  });
});

describe("graceful shutdown of a consumer process (real child process)", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "shutdown", queues: { visibilityTimeoutSeconds: 30 } });
  });
  afterEach(async () => {
    await killAllInstances();
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await killAllInstances();
    await h.close();
  });

  const childConfig = (h: MessagingHarness, extra: Record<string, unknown>) => ({
    ...h.config,
    ROLES: ["consumer" as const],
    LOG_LEVEL: "info" as const,
    ...extra,
  });

  test("SIGTERM with a message in flight: it finishes, is acked and the process exits cleanly", async () => {
    const w = await h.openWallet("100.00");
    const child = await spawnInstance({
      name: "consumer-graceful",
      config: childConfig(h, { FAULTS: "consumer:after-inbox-insert=delay:2000*1", SHUTDOWN_GRACE_MS: 15_000 }),
    });
    const command = wagerCommand(w, { money: { amount: "20.00", currency: "BRL" } });
    await sendEnvelope(h.queues, wagerEnvelope(command));
    await waitFor(async () => (await h.queues.input.approximateDepth()).inFlight > 0, { description: "in flight" });

    const code = await child.stop();
    expect(code).toBe(0);
    expect((await txRow(h, command.providerId, command.externalTransactionId))?.status).toBe("PROCESSED");
    await waitFor(() => queueIsEmpty(h), { description: "acked before exit" });
    expect(await balance(h, w.id)).toBe("80.00");
  });

  test("SIGTERM when the grace period is shorter than the work: visibility is returned, nothing is lost or duplicated", async () => {
    const w = await h.openWallet("100.00");
    const child = await spawnInstance({
      name: "consumer-release",
      config: childConfig(h, { FAULTS: "consumer:after-inbox-insert=delay:5000*1", SHUTDOWN_GRACE_MS: 200 }),
    });
    const command = wagerCommand(w, { money: { amount: "20.00", currency: "BRL" } });
    const envelope = wagerEnvelope(command);
    await sendEnvelope(h.queues, envelope);
    await waitFor(async () => (await h.queues.input.approximateDepth()).inFlight > 0, { description: "in flight" });

    const stoppedAt = Date.now();
    expect(await child.stop()).toBe(0);
    // The unfinished message was handed back (ChangeMessageVisibility 0) instead of being acked.
    const stopped = jsonLogs(child).find((line) => line.msg === "consumer stopped");
    expect(stopped?.released).toBe(1);
    // Its transaction either committed while the pool drained or was rolled back with the
    // connection; either way the message is available again right away (not after 30 s).
    await waitFor(async () => (await h.queues.input.approximateDepth()).visible === 1, {
      description: "visible again",
      timeoutMs: 5_000,
    });
    expect(Date.now() - stoppedAt).toBeLessThan(20_000);

    await h.start();
    const row = await waitFor(() => txRow(h, command.providerId, command.externalTransactionId), { description: "applied" });
    expect(row.status).toBe("PROCESSED");
    await waitFor(() => queueIsEmpty(h), { description: "acked" });
    expect(await count(h, "inbox_messages", `message_id = '${envelope.messageId}'`)).toBe(1);
    expect(await count(h, "wallet_ledger_entries", `wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    expect(await balance(h, w.id)).toBe("80.00");
  });
});
