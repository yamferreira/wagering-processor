import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { assertLedgerInvariant } from "../../support/invariants";
import type { Logger } from "../../../src/application/ports/logger";
import type { Runtime } from "../../../src/infrastructure/app/runtime";
import { createLogger, REDACTED } from "../../../src/infrastructure/observability/logger";
import { createMessagingHarness, type MessagingHarness, sendEnvelope, wagerEnvelope } from "../../support/messaging";
import { wagerCommand } from "../../support/use-cases";
import { waitFor } from "../../support/wait";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * §12: JSON logs with correlationId, messageId, transactionId, walletId and providerId; no
 * sensitive data or full financial payloads. The amounts used here are distinctive so the raw
 * log text can be searched for them — and cannot occur inside an ISO timestamp (seconds are
 * 00–59, so "71.11" or "731.19" never match "…:SS.mmm").
 */
const AMOUNTS = ["731.19", "123.45", "607.74", "5000.00", "71.11", "92.42"];

class CapturedLog {
  readonly raw: string[] = [];
  write(chunk: string): void {
    for (const line of chunk.split("\n")) if (line.trim()) this.raw.push(line);
  }
  get lines(): Record<string, any>[] {
    return this.raw.map((line) => JSON.parse(line));
  }
  find(predicate: (line: Record<string, any>) => boolean) {
    return this.lines.find(predicate);
  }
}

describe("structured logging", () => {
  let h: MessagingHarness;
  let capture: CapturedLog;
  let logger: Logger;
  let runtime: Runtime;
  let base: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "logging" });
    capture = new CapturedLog();
    logger = createLogger({ level: "debug", destination: capture });
    runtime = await h.start({ ROLES: ["api", "consumer", "pending-worker"] }, { logger });
    base = `http://127.0.0.1:${runtime.port}`;
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql); // §13: the invariant closes every test
  });
  afterAll(async () => {
    await h.close();
  });

  test("HTTP, SQS and worker lines carry the identifiers of their unit of work and never the money", async () => {
    // HTTP: wallet, BET, replay, business rejection, invalid payload.
    const walletResponse = await post("/wallets", { playerId: `log-${crypto.randomUUID()}`, initialBalance: { amount: "731.19", currency: "BRL" } }, { "X-Correlation-Id": "corr-wallet" });
    const wallet = (await walletResponse.json()) as { id: string; playerId: string };
    const bet = wagerCommand(wallet, { money: { amount: "123.45", currency: "BRL" } });
    const { idempotencyKey, ...betBody } = bet;
    const created = await post("/wagering/transactions", betBody, { "Idempotency-Key": idempotencyKey, "X-Correlation-Id": "corr-bet" });
    expect(created.status).toBe(201);
    const { transactionId } = (await created.json()) as { transactionId: string };
    expect((await post("/wagering/transactions", betBody, { "Idempotency-Key": idempotencyKey })).status).toBe(200);
    const tooBig = wagerCommand(wallet, { money: { amount: "5000.00", currency: "BRL" } });
    const { idempotencyKey: bigKey, ...bigBody } = tooBig;
    expect((await post("/wagering/transactions", bigBody, { "Idempotency-Key": bigKey })).status).toBe(422);
    expect((await post("/wagering/transactions", { kind: "BET", money: { amount: "92.42" } }, { "Idempotency-Key": "k-invalid" })).status).toBe(400);

    // SQS.
    const viaQueue = wagerCommand(wallet, { money: { amount: "71.11", currency: "BRL" } });
    const envelope = wagerEnvelope(viaQueue, { correlationId: "corr-sqs" });
    await sendEnvelope(h.queues, envelope);
    const processed = await waitFor(() => capture.find((l) => l.msg === "message processed" && l.messageId === envelope.messageId), {
      description: "consumer log line",
    });

    // Worker: a ROLLBACK that waits for its BET, resolved after the BET arrives.
    const late = wagerCommand(wallet, { roundId: "r-late", money: { amount: "71.11", currency: "BRL" } });
    const rollback = wagerCommand(wallet, {
      kind: "ROLLBACK",
      roundId: "r-late",
      referenceExternalTransactionId: late.externalTransactionId,
      money: { amount: "71.11", currency: "BRL" },
    });
    const { idempotencyKey: rbKey, ...rbBody } = rollback;
    const pending = await post("/wagering/transactions", rbBody, { "Idempotency-Key": rbKey });
    expect(pending.status).toBe(202);
    const { transactionId: rollbackId } = (await pending.json()) as { transactionId: string };
    const { idempotencyKey: lateKey, ...lateBody } = late;
    expect((await post("/wagering/transactions", lateBody, { "Idempotency-Key": lateKey })).status).toBe(201);
    const resolved = await waitFor(() => capture.find((l) => l.msg === "pending reference resolved" && l.transactionId === rollbackId), {
      description: "worker log line",
    });

    // Every line is JSON (parse throws otherwise) with the base fields.
    for (const line of capture.lines) {
      expect(typeof line.time).toBe("string");
      expect(typeof line.level).toBe("string");
      expect(line.service).toBe("wagering-processor");
    }

    const walletLine = capture.find((l) => l.msg === "http request" && l.correlationId === "corr-wallet");
    expect(walletLine).toMatchObject({ method: "POST", route: "/wallets", status: 201, walletId: wallet.id });

    const betLine = capture.find((l) => l.msg === "http request" && l.correlationId === "corr-bet");
    expect(betLine).toMatchObject({
      method: "POST",
      route: "/wagering/transactions",
      status: 201,
      transactionId,
      walletId: wallet.id,
      providerId: bet.providerId,
      txStatus: "PROCESSED",
      idempotentReplay: false,
    });
    expect(capture.find((l) => l.msg === "http request" && l.status === 200 && l.idempotentReplay === true)).toBeDefined();
    expect(capture.find((l) => l.msg === "http request" && l.status === 422)?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(capture.find((l) => l.msg === "http request" && l.status === 400)?.correlationId).toBeDefined();

    expect(processed).toMatchObject({
      correlationId: "corr-sqs",
      messageId: envelope.messageId,
      walletId: wallet.id,
      providerId: viaQueue.providerId,
      outcome: "APPLIED",
      txStatus: "PROCESSED",
    });
    expect(typeof processed.transactionId).toBe("string");
    expect(resolved).toMatchObject({ transactionId: rollbackId, walletId: wallet.id, resolution: "PROCESSED" });

    // No financial values anywhere in the raw output (no amount, balance or payload).
    const everything = capture.raw.join("\n");
    for (const amount of AMOUNTS) expect(everything).not.toContain(amount);
    expect(everything).not.toContain('"externalTransactionId"');
  });

  test("sensitive keys are redacted even if someone logs them by mistake", () => {
    logger.info(
      {
        money: { amount: "9.99", currency: "BRL" },
        balance: "1.00",
        nested: { amount: "2.00", deeper: { balance: "3.00" } },
        payload: { anything: true },
        walletId: "w-1",
      },
      "redaction probe",
    );
    const line = capture.find((l) => l.msg === "redaction probe")!;
    expect(line.money).toBe(REDACTED);
    expect(line.balance).toBe(REDACTED);
    expect(line.nested.amount).toBe(REDACTED);
    expect(line.nested.deeper.balance).toBe(REDACTED);
    expect(line.payload).toBe(REDACTED);
    expect(line.walletId).toBe("w-1");
    expect(capture.raw.at(-1)).not.toContain("9.99");
  });
});
