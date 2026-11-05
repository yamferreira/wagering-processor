import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { EventPublisher } from "../../../src/application/ports/event-publisher";
import { InjectedFaultError } from "../../../src/application/ports/fault-injector";
import type { Runtime } from "../../../src/infrastructure/app/runtime";
import { EventAuditConsumer } from "../../support/event-audit-consumer";
import { assertLedgerInvariant } from "../../support/invariants";
import { createMessagingHarness, type MessagingHarness } from "../../support/messaging";
import { drainQueue } from "../../support/sqs";
import { CTX, wagerCommand } from "../../support/use-cases";
import { waitFor } from "../../support/wait";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * T15 — Transactional Outbox publisher (§11) against real PostgreSQL and LocalStack.
 * Events are produced by the real use cases (wallet openings and BETs) with no publisher
 * running, which is exactly the state left by a process that committed and died before
 * publishing.
 */
async function pendingCount(h: MessagingHarness): Promise<number> {
  const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
  return row.n;
}

async function totalCount(h: MessagingHarness): Promise<number> {
  const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM outbox_messages`;
  return row.n;
}

/** 30 wallets (OPENING → 2 events each) + 120 BETs (2 events each) = 300 events. */
async function produceEvents(h: MessagingHarness, wallets = 30, betsPerWallet = 4): Promise<string[]> {
  const ids: string[] = [];
  await Promise.all(
    Array.from({ length: wallets }, async () => {
      const wallet = await h.openWallet("1000.00");
      ids.push(wallet.id);
      for (let i = 0; i < betsPerWallet; i++) {
        await h.container.submit.execute(wagerCommand(wallet, { money: { amount: "1.00", currency: "BRL" } }), CTX);
      }
    }),
  );
  return ids;
}

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];

  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: Parameters<EventPublisher["publish"]>[0]) {
    const outcome = await this.inner.publish(messages);
    this.published.push(...outcome.published);
    return outcome;
  }
}

describe("outbox publisher", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "outbox" });
    await EventAuditConsumer.install(h.db.sql);
  });
  afterEach(async () => {
    for (const runtime of h.runtimes.splice(0)) await runtime.stop();
    h.faults.reset();
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await h.close();
  });

  test("3 concurrent publishers over 300 events: all published, no row claimed twice, every eventId delivered", async () => {
    await produceEvents(h);
    expect(await totalCount(h)).toBe(300);
    expect(await pendingCount(h)).toBe(300);

    const recorders: RecordingPublisher[] = [];
    const runtimes: Runtime[] = [];
    for (let i = 0; i < 3; i++) {
      runtimes.push(
        await h.start(
          { ROLES: ["publisher"], OUTBOX_BATCH_SIZE: 20 },
          {
            decorate: (inner) => {
              const recorder = new RecordingPublisher(inner);
              recorders.push(recorder);
              return recorder;
            },
          },
        ),
      );
    }
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "outbox drained", timeoutMs: 30_000 });

    // SKIP LOCKED: the three publishers split the work without overlapping.
    const all = recorders.flatMap((r) => r.published);
    expect(new Set(all).size).toBe(300);
    expect(all.length).toBe(300);
    expect(recorders.filter((r) => r.published.length > 0).length).toBeGreaterThanOrEqual(2);

    const [stats] = await h.db.sql`
      SELECT COUNT(*) FILTER (WHERE published_at IS NULL)::int AS pending,
             COUNT(*) FILTER (WHERE attempts > 0)::int AS retried
        FROM outbox_messages`;
    expect(stats).toEqual({ pending: 0, retried: 0 });

    const bodies = await drainQueue(h.queues.events, { idleRounds: 2 });
    const eventIds = bodies.map((body) => JSON.parse(body).eventId as string);
    const unique = new Set(eventIds);
    const [rows] = await h.db.sql`SELECT array_agg(id::text) AS ids FROM outbox_messages`;
    expect([...unique].sort()).toEqual([...(rows.ids as string[])].sort());
    console.log(`[outbox] delivered=${eventIds.length} unique=${unique.size} duplicates=${eventIds.length - unique.size}`);
  });

  test("claimDue uses SKIP LOCKED: rows claimed by an open transaction are invisible to a second claimer", async () => {
    await produceEvents(h, 2, 1); // 8 events
    const runner = h.container.runner;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first: string[] | undefined;
    const holder = runner.run(async (repos) => {
      first = (await repos.outbox.claimDue(new Date(), 3)).map((m) => m.id);
      await gate; // keep the row locks
    });
    await waitFor(() => first, { description: "first claim" });
    const second = await runner.run(async (repos) => (await repos.outbox.claimDue(new Date(), 100)).map((m) => m.id));
    release();
    await holder;
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(5);
    expect(second.filter((id) => first!.includes(id))).toEqual([]);

    await h.start({ ROLES: ["publisher"] });
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "published" });
    await drainQueue(h.queues.events);
  });

  test("committed while no publisher was alive (crash before publish): another instance publishes it", async () => {
    const [walletId] = await produceEvents(h, 1, 1);
    expect(await pendingCount(h)).toBe(4);
    await h.start({ ROLES: ["publisher"] });
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "published" });
    const bodies = await drainQueue(h.queues.events);
    expect(bodies.some((body) => JSON.parse(body).aggregateId === walletId)).toBe(true);
  });

  test("a publisher dying between claim and publish releases its rows to the next one", async () => {
    await produceEvents(h, 1, 1);
    h.faults.throwAt("outbox:after-claim-before-publish", () => new InjectedFaultError("outbox:after-claim-before-publish"), 1);
    await h.start({ ROLES: ["publisher"] });
    await waitFor(() => h.faults.hits.includes("outbox:after-claim-before-publish"), { description: "fault hit" });
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "published by the retry" });
    const [row] = await h.db.sql`SELECT MAX(attempts)::int AS attempts FROM outbox_messages WHERE published_at IS NOT NULL`;
    expect(row.attempts).toBe(0); // the aborted claim rolled back: no attempt was recorded
    await drainQueue(h.queues.events);
  });

  test("SQS unavailable: attempts grow with exponential backoff; once SQS is back the events are published", async () => {
    await produceEvents(h, 1, 0); // 2 events
    expect(await pendingCount(h)).toBe(2);
    await h.start({ ROLES: ["publisher"], SQS_ENDPOINT: "http://127.0.0.1:1" });

    const first = await waitFor(async () => {
      const [row] = await h.db.sql`
        SELECT id, attempts, next_attempt_at, last_error FROM outbox_messages WHERE published_at IS NULL ORDER BY id LIMIT 1`;
      return row && row.attempts >= 1 ? row : undefined;
    }, { description: "first failed attempt" });
    expect(first.last_error).toBeTruthy();
    const second = await waitFor(async () => {
      const [row] = await h.db.sql`
        SELECT attempts, next_attempt_at FROM outbox_messages WHERE id = ${first.id}`;
      return row && row.attempts >= 2 ? row : undefined;
    }, { description: "second failed attempt", timeoutMs: 10_000 });
    // delay(1) = 2 s · (1 − ≤20% jitter): the next attempt is pushed further out than the first.
    const gap = new Date(second.next_attempt_at).getTime() - new Date(first.next_attempt_at).getTime();
    expect(gap).toBeGreaterThanOrEqual(1_500);

    for (const runtime of h.runtimes.splice(0)) await runtime.stop();
    await h.start({ ROLES: ["publisher"] });
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "published after recovery", timeoutMs: 20_000 });
    // Each row has its own jittered schedule, so they are not necessarily retried together: check the
    // row that was observed failing twice, and that every row failed at least once before publishing.
    const [tracked] = await h.db.sql`SELECT attempts, published_at FROM outbox_messages WHERE id = ${first.id}`;
    expect(tracked.attempts).toBeGreaterThanOrEqual(2);
    expect(tracked.published_at).not.toBeNull();
    const [row] = await h.db.sql`SELECT MIN(attempts)::int AS attempts FROM outbox_messages WHERE last_error IS NOT NULL`;
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    await drainQueue(h.queues.events);
  });

  test("crash after publishing and before marking: the event is published again (at-least-once)", async () => {
    await produceEvents(h, 1, 0);
    h.faults.throwAt("outbox:after-publish-before-mark", () => new InjectedFaultError("outbox:after-publish-before-mark"), 1);
    const recorders: RecordingPublisher[] = [];
    await h.start(
      { ROLES: ["publisher"] },
      { decorate: (inner) => recorders[recorders.push(new RecordingPublisher(inner)) - 1]! },
    );
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "marked after the retry" });
    const published = recorders.flatMap((r) => r.published);
    expect(published.length).toBe(4); // 2 events, each sent twice
    expect(new Set(published).size).toBe(2);
    await drainQueue(h.queues.events);
  });

  test("duplicate publications are harmless for a consumer with an inbox (eventId)", async () => {
    await produceEvents(h, 3, 2); // 3 × (2 + 4) = 18 events
    await h.start({ ROLES: ["publisher"] });
    await waitFor(async () => (await pendingCount(h)) === 0, { description: "published" });
    const bodies = await drainQueue(h.queues.events);
    expect(bodies.length).toBeGreaterThanOrEqual(18);

    // Re-publish every event, as happens when a publisher dies after the broker accepted the batch
    // and the broker's 5-minute deduplication window no longer covers it.
    for (const body of [...bodies, ...bodies]) {
      const { aggregateId } = JSON.parse(body);
      await h.queues.events.send({ body, groupId: aggregateId, deduplicationId: crypto.randomUUID() });
    }
    const audit = new EventAuditConsumer(h.db.sql, h.queues.events);
    await audit.drain();
    for (const body of bodies) await audit["apply"](body); // and a direct third copy, in-process

    const unique = new Set(bodies.map((b) => JSON.parse(b).eventId)).size;
    expect(audit.applied).toBe(unique);
    expect(audit.duplicates).toBe(audit.delivered - unique);
    const [projection] = await h.db.sql`SELECT COALESCE(SUM(events_applied), 0)::int AS applied FROM audit_projection`;
    expect(projection.applied).toBe(unique);
  });
});
