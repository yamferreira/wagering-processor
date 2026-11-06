import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { pidAlive, spawnCluster } from "../support/cluster";
import { waitForQuiescence } from "../support/drain";
import { jsonLogs, killAllInstances, liveInstanceCount } from "../support/instances";
import { assertLedgerInvariant } from "../support/invariants";
import { fireHttp } from "../support/load";
import { createMessagingHarness, type MessagingHarness } from "../support/messaging";
import { wagerCommand } from "../support/use-cases";
import { waitFor } from "../support/wait";

// Real processes, PostgreSQL and LocalStack: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(120_000);

/** The process harness itself: 3 real instances come up, serve, and go down without orphans. */
describe("process harness", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "harness" });
  });
  afterEach(async () => {
    await killAllInstances();
  });
  afterAll(async () => {
    await killAllInstances();
    await h.close();
  });

  test("3 instances (all roles) become ready, serve requests, and stop gracefully with no orphan left", async () => {
    const instances = await spawnCluster(h, 3);
    expect(liveInstanceCount()).toBe(3);
    const pids = instances.map((i) => i.proc.pid);
    expect(new Set(instances.map((i) => i.port)).size).toBe(3);

    for (const instance of instances) {
      const ready = await fetch(`${instance.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      const started = jsonLogs(instance).find((line) => line.msg === "runtime started");
      expect(started?.roles).toEqual(["api", "consumer", "publisher", "pending-worker"]);
    }

    const wallet = await h.openWallet("100.00");
    const results = await fireHttp(
      instances.map((i) => i.baseUrl),
      Array.from({ length: 6 }, () => wagerCommand(wallet, { money: { amount: "1.00", currency: "BRL" } })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    await waitForQuiescence(h.db.sql, h.queues); // the instances' publishers drained the outbox

    const codes = await Promise.all(instances.map((i) => i.stop()));
    expect(codes).toEqual([0, 0, 0]);
    expect(liveInstanceCount()).toBe(0);
    await waitFor(() => pids.every((pid) => !pidAlive(pid)), { description: "no orphan process", timeoutMs: 5_000 });
    await assertLedgerInvariant(h.db.sql);
  });

  test("kill() is abrupt (crash) and still leaves no orphan", async () => {
    const [instance] = await spawnCluster(h, 1);
    const pid = instance!.proc.pid;
    const code = await instance!.kill();
    expect(code).not.toBe(0);
    await waitFor(() => !pidAlive(pid), { description: "killed", timeoutMs: 5_000 });
    expect(jsonLogs(instance!).some((line) => line.msg === "shutting down")).toBe(false);
  });

  test("ROLES splits the responsibilities of an instance", async () => {
    const [publisherOnly] = await spawnCluster(h, 1, () => ({ ROLES: ["publisher"] }));
    const started = jsonLogs(publisherOnly!).find((line) => line.msg === "runtime started");
    expect(started?.roles).toEqual(["publisher"]);
    expect(publisherOnly!.port).toBe(0); // no HTTP server in this process
    expect(await publisherOnly!.stop()).toBe(0);
  });
});
