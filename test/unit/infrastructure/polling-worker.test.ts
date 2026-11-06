import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../../src/application/ports/logger";
import { PollingWorker } from "../../../src/infrastructure/workers/polling-worker";

/** A round that takes 300 ms, then reports no more work (or throws). */
function slowRound(outcome: "ok" | "throw") {
  let rounds = 0;
  return {
    get rounds() {
      return rounds;
    },
    round: async () => {
      rounds++;
      await Bun.sleep(300);
      if (outcome === "throw") throw new Error("database unavailable");
      return { moreWork: false };
    },
  };
}

describe("PollingWorker.stop()", () => {
  test.each(["ok", "throw"] as const)(
    "called during a round (%s) waits for that round only, not for the idle delay or the error backoff",
    async (outcome) => {
      const work = slowRound(outcome);
      const worker = new PollingWorker(work.round, { name: "test", idleDelayMs: 5_000, maxErrorDelayMs: 10_000 }, silentLogger);
      worker.start();
      await Bun.sleep(100); // mid-round

      const startedAt = performance.now();
      await worker.stop();
      const elapsed = performance.now() - startedAt;

      expect(elapsed).toBeLessThan(1_000); // the round has ~200 ms left
      expect(work.rounds).toBe(1);
    },
  );

  test("called while sleeping returns at once", async () => {
    const work = slowRound("ok");
    const worker = new PollingWorker(work.round, { name: "test", idleDelayMs: 5_000 }, silentLogger);
    worker.start();
    await Bun.sleep(500); // round done, now in the 5 s idle delay

    const startedAt = performance.now();
    await worker.stop();
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(work.rounds).toBe(1);
  });
});
