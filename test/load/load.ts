/**
 * `bun run test:load` — load test (§14, diferencial): 1 instance vs 3 instances.
 *
 * For each scenario: a fresh database + fresh queues, N real instances (`bun src/main.ts`, all roles),
 * a closed-loop HTTP load (C concurrent clients, round-robin over the instances) of mixed operations,
 * then drain and verify consistency. Writes a Markdown report to reports/load-<timestamp>.md.
 *
 * Env knobs: LOAD_DURATION_S (20), LOAD_WARMUP_S (3), LOAD_WALLETS (200), LOAD_LOG_LEVEL ("warn"),
 * LOAD_SCENARIOS ("1x8,3x8,1x64,3x64" = instances x concurrent clients).
 */
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../src/infrastructure/config/config";
import { driverProbe } from "./driver-probe";
import { createTestDatabase, type TestDatabase } from "../support/db";
import { findLedgerDivergences } from "../support/invariants";
import { type Instance, killAllInstances, spawnInstance } from "../support/instances";
import { createTestQueues, type TestQueues } from "../support/sqs";

const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 20);
const WARMUP_S = Number(process.env.LOAD_WARMUP_S ?? 3);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const SCENARIOS = (process.env.LOAD_SCENARIOS ?? "1x8,3x8,1x64,3x64").split(",").map((spec) => {
  const [instances, clients] = spec.split("x").map(Number);
  return { instances: instances!, clients: clients! };
});
const LOG_LEVEL = process.env.LOAD_LOG_LEVEL ?? "warn";
const HOT_WALLET_SHARE = 0.1;

type Op = "BET" | "WIN" | "REPLAY" | "HOT_BET";
interface Sample {
  op: Op;
  status: number;
  ms: number;
  at: number;
}
interface WalletRef {
  id: string;
  playerId: string;
}

// ------------------------------------------------------------------ helpers
const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : NaN);
const fmt = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "—");

function parseMetrics(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+?)(\{.*\})?\s+(\S+)$/.exec(line);
    if (!match) continue;
    const key = match[1]! + (match[2] ?? "");
    out.set(key, (out.get(key) ?? 0) + Number(match[3]));
  }
  return out;
}
const sumWhere = (m: Map<string, number>, prefix: string, contains = "") =>
  [...m].filter(([k]) => k.startsWith(prefix) && k.includes(contains)).reduce((a, [, v]) => a + v, 0);
async function scrape(instance: Instance): Promise<Map<string, number>> {
  return parseMetrics(await (await fetch(`${instance.baseUrl}/metrics`)).text());
}

/** p-quantile estimate from a Prometheus histogram (bucket upper bound where the rank falls). */
function histogramQuantile(m: Map<string, number>, name: string, q: number): number {
  const buckets = [...m]
    .filter(([k]) => k.startsWith(`${name}_bucket`))
    .map(([k, v]) => ({ le: k.includes('le="+Inf"') ? Infinity : Number(/le="([^"]+)"/.exec(k)?.[1]), v }))
    .sort((a, b) => a.le - b.le);
  const total = buckets.at(-1)?.v ?? 0;
  const bucket = buckets.find((b) => b.v >= q * total);
  return bucket ? bucket.le : NaN;
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ scenario
interface ScenarioResult {
  instances: number;
  clients: number;
  /** Busy fraction of all host CPUs during the measured window (generator + instances + Docker). */
  hostCpuBusy: number;
  /** Cores used by this load-generator process during the measured window. */
  generatorCores: number;
  samples: Sample[];
  measuredSeconds: number;
  cpuSecondsPerInstance: number[];
  metrics: Map<string, number>;
  outboxLagMaxS: number;
  outboxPendingMax: number;
  drainSeconds: number;
  divergences: number;
  ledgerEntries: number;
  networkErrors: number;
}

function hostCpuTimes() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.busy += t.user + t.nice + t.sys + t.irq;
      acc.total += t.user + t.nice + t.sys + t.irq + t.idle;
      return acc;
    },
    { busy: 0, total: 0 },
  );
}

async function runScenario(instanceCount: number, CONCURRENCY: number): Promise<ScenarioResult> {
  const db: TestDatabase = await createTestDatabase();
  const queues: TestQueues = await createTestQueues({ label: `load${instanceCount}` });
  const base = loadConfig(process.env, {
    DATABASE_URL: db.url,
    SQS_INPUT_QUEUE: queues.topology.input,
    SQS_DLQ: queues.topology.dlq,
    SQS_EVENTS_QUEUE: queues.topology.events,
  });
  try {
    const instances = await Promise.all(
      Array.from({ length: instanceCount }, (_, i) =>
        spawnInstance({
          name: `load-${instanceCount}-${i + 1}`,
          config: { ...base, PORT: 0, LOG_LEVEL: LOG_LEVEL as never, DB_POOL_MAX: 20, SQS_WAIT_TIME_S: 5 },
        }),
      ),
    );
    const urls = instances.map((i) => i.baseUrl);

    // Fixtures: WALLETS normal wallets + 1 hot wallet, all with plenty of balance.
    const wallets: WalletRef[] = [];
    for (let i = 0; i < WALLETS + 1; i += 20) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(20, WALLETS + 1 - i) }, async (_, j) => {
          const response = await post(urls[(i + j) % urls.length]!, "/wallets", {
            playerId: `load-${crypto.randomUUID()}`,
            initialBalance: { amount: "1000000.00", currency: "BRL" },
          });
          return (await response.json()) as WalletRef;
        }),
      );
      wallets.push(...batch);
    }
    const hot = wallets.pop()!;

    const before = await Promise.all(instances.map(scrape));
    const samples: Sample[] = [];
    let networkErrors = 0;
    const startedAt = performance.now();
    const endAt = startedAt + (WARMUP_S + DURATION_S) * 1_000;
    const warmupEnd = startedAt + WARMUP_S * 1_000;
    let sequence = 0;
    const recentBets: { wallet: WalletRef; ext: string; key: string; body: Record<string, unknown> }[] = [];
    let hostAtWarmup: ReturnType<typeof hostCpuTimes> | undefined;
    let generatorAtWarmup: NodeJS.CpuUsage | undefined;
    const warmupTimer = setTimeout(() => {
      hostAtWarmup = hostCpuTimes();
      generatorAtWarmup = process.cpuUsage();
    }, WARMUP_S * 1_000);

    // Outbox lag sampler (global gauges, any instance).
    let outboxLagMaxS = 0;
    let outboxPendingMax = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const m = await scrape(instances[0]!);
          outboxLagMaxS = Math.max(outboxLagMaxS, m.get("outbox_lag_seconds") ?? 0);
          outboxPendingMax = Math.max(outboxPendingMax, m.get("outbox_pending") ?? 0);
        } catch {}
        await Bun.sleep(1_000);
      }
    })();

    const client = async (clientId: number) => {
      while (performance.now() < endAt) {
        sequence++;
        const roll = Math.random();
        let op: Op;
        let body: Record<string, unknown>;
        let key: string;
        if (roll < HOT_WALLET_SHARE) {
          op = "HOT_BET";
          const ext = `hot-${clientId}-${sequence}`;
          key = `load:${ext}`;
          body = bet(hot, ext);
        } else if (roll < 0.15 && recentBets.length > 0) {
          op = "REPLAY";
          const previous = recentBets[Math.floor(Math.random() * recentBets.length)]!;
          key = previous.key;
          body = previous.body;
        } else if (roll < 0.35 && recentBets.length > 0) {
          op = "WIN";
          const previous = recentBets[Math.floor(Math.random() * recentBets.length)]!;
          const ext = `win-${clientId}-${sequence}`;
          key = `load:${ext}`;
          body = {
            ...bet(previous.wallet, ext),
            roundId: previous.body.roundId, // a settlement belongs to the round of its BET
            kind: "WIN",
            referenceExternalTransactionId: previous.ext,
            money: { amount: "2.00", currency: "BRL" },
          };
        } else {
          op = "BET";
          const wallet = wallets[Math.floor(Math.random() * wallets.length)]!;
          const ext = `bet-${clientId}-${sequence}`;
          key = `load:${ext}`;
          body = bet(wallet, ext);
        }
        const t0 = performance.now();
        try {
          const response = await post(urls[sequence % urls.length]!, "/wagering/transactions", body, { "Idempotency-Key": key });
          await response.arrayBuffer();
          if (t0 >= warmupEnd) samples.push({ op, status: response.status, ms: performance.now() - t0, at: t0 });
          // Only committed BETs become references for WINs / replays (no accidental PENDING_REFERENCE).
          if (op === "BET" && response.status === 201) {
            const entry = { wallet: walletOf(body), ext: body.externalTransactionId as string, key, body };
            if (recentBets.length < 5_000) recentBets.push(entry);
            else recentBets[Math.floor(Math.random() * recentBets.length)] = entry;
          }
        } catch {
          networkErrors++;
        }
      }
    };
    const walletById = new Map(wallets.map((w) => [w.id, w]));
    const walletOf = (body: Record<string, unknown>) => walletById.get(body.walletId as string)!;
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => client(i)));
    clearTimeout(warmupTimer);
    const measuredSeconds = (performance.now() - warmupEnd) / 1_000;
    const hostNow = hostCpuTimes();
    const hostCpuBusy = hostAtWarmup ? (hostNow.busy - hostAtWarmup.busy) / Math.max(1, hostNow.total - hostAtWarmup.total) : NaN;
    const generatorUsage = process.cpuUsage(generatorAtWarmup);
    const generatorCores = (generatorUsage.user + generatorUsage.system) / 1e6 / measuredSeconds;
    const after = await Promise.all(instances.map(scrape));

    // Drain: outbox fully published.
    const drainStart = performance.now();
    for (;;) {
      const [row] = await db.sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
      if (row.n === 0) break;
      if (performance.now() - drainStart > 120_000) break;
      await Bun.sleep(250);
    }
    const drainSeconds = (performance.now() - drainStart) / 1_000;
    sampling = false;
    await sampler;

    const divergences = (await findLedgerDivergences(db.sql)).length;
    const [entries] = await db.sql`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries`;
    const cpuSecondsPerInstance = after.map(
      (m, i) => (m.get("process_cpu_seconds_total") ?? 0) - (before[i]!.get("process_cpu_seconds_total") ?? 0),
    );
    const metrics = new Map<string, number>();
    for (const [i, m] of after.entries()) {
      for (const [k, v] of m) metrics.set(k, (metrics.get(k) ?? 0) + v - (before[i]!.get(k) ?? 0));
    }
    await Promise.all(instances.map((i) => i.stop()));
    return {
      instances: instanceCount,
      clients: CONCURRENCY,
      hostCpuBusy,
      generatorCores,
      samples,
      measuredSeconds,
      cpuSecondsPerInstance,
      metrics,
      outboxLagMaxS,
      outboxPendingMax,
      drainSeconds,
      divergences,
      ledgerEntries: entries.n,
      networkErrors,
    };
  } finally {
    await killAllInstances();
    await queues.destroy();
    await db.drop();
  }
}

function bet(wallet: WalletRef, ext: string): Record<string, unknown> {
  return {
    providerId: "load",
    externalTransactionId: ext,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${ext}`,
    gameId: "load-game",
    kind: "BET",
    money: { amount: "1.00", currency: "BRL" },
  };
}

// ------------------------------------------------------------------ report
function summarize(result: ScenarioResult) {
  const all = result.samples;
  const latencies = all.map((s) => s.ms).sort((a, b) => a - b);
  const ok = all.filter((s) => s.status < 300).length;
  const errors5xx = all.filter((s) => s.status >= 500).length;
  const byOp = (op: Op) => all.filter((s) => s.op === op).map((s) => s.ms).sort((a, b) => a - b);
  const writes = all.filter((s) => s.op !== "REPLAY" && s.status < 300).length;
  const cpuTotal = result.cpuSecondsPerInstance.reduce((a, b) => a + b, 0);
  const m = result.metrics;
  return {
    requests: all.length,
    rps: all.length / result.measuredSeconds,
    okRps: ok / result.measuredSeconds,
    errorRate: (errors5xx + result.networkErrors) / Math.max(1, all.length + result.networkErrors),
    statuses: Object.entries(all.reduce((acc: Record<number, number>, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {})),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? NaN,
    ops: (["BET", "WIN", "REPLAY", "HOT_BET"] as Op[]).map((op) => {
      const l = byOp(op);
      return { op, n: l.length, p50: percentile(l, 50), p95: percentile(l, 95), p99: percentile(l, 99) };
    }),
    cpuCoresPerInstance: result.cpuSecondsPerInstance.map((c) => c / result.measuredSeconds),
    cpuMsPerRequest: (cpuTotal * 1_000) / Math.max(1, all.length),
    cpuMsPerWrite: (cpuTotal * 1_000) / Math.max(1, writes),
    lockWaitP95ms: histogramQuantile(m, "wallet_lock_wait_seconds", 0.95) * 1_000,
    lockWaitP99ms: histogramQuantile(m, "wallet_lock_wait_seconds", 0.99) * 1_000,
    lockWaitAvgMs: ((m.get("wallet_lock_wait_seconds_sum") ?? 0) / Math.max(1, m.get("wallet_lock_wait_seconds_count") ?? 0)) * 1_000,
    lockConflicts: sumWhere(m, "wallet_lock_conflicts_total"),
    dbRetries: sumWhere(m, "retries_total", 'component="db_transaction"'),
    replays: sumWhere(m, "idempotent_replays_total"),
  };
}

async function main() {
  const startedAt = new Date();
  const probeDb = await createTestDatabase();
  const probe = await driverProbe(probeDb.url).finally(() => probeDb.drop());
  const results: ScenarioResult[] = [];
  for (const { instances, clients } of SCENARIOS) {
    console.log(`[load] scenario: ${instances} instance(s), ${clients} clients, ${DURATION_S}s (+${WARMUP_S}s warm-up)…`);
    results.push(await runScenario(instances, clients));
  }
  const summaries = results.map((r) => ({ r, s: summarize(r) }));
  const pg = (await (async () => {
    const db = await createTestDatabase();
    try {
      const [row] = await db.sql`SELECT version() AS v, current_setting('max_connections') AS mc`;
      return `${String(row.v).split(" on ")[0]} (max_connections=${row.mc})`;
    } finally {
      await db.drop();
    }
  })());

  const lines: string[] = [];
  lines.push(`# Load test report — ${startedAt.toISOString()}`, "");
  lines.push("## Environment", "");
  lines.push(`- Host: ${os.type()} ${os.release()} (${os.arch()}), ${os.cpus().length} logical CPUs (${os.cpus()[0]?.model.trim()}), ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM`);
  lines.push(`- Bun ${Bun.version}; ${pg} and LocalStack 4.14.0 in Docker on the same host`);
  lines.push("- Load generator: this Bun process, N concurrent closed-loop clients over HTTP (keep-alive), round-robin across instances — on the same host as everything else");
  lines.push(`- Instances: \`bun src/main.ts\` with all roles (api, consumer, publisher, pending-worker), DB pool 20 each, LOG_LEVEL=${LOG_LEVEL}`);
  lines.push(
    `- Driver probe (sequential SELECT 1, this process): MikroORM/pg ${fmt(probe.mikroOrm.wall, 2)} ms wall, ${fmt(probe.mikroOrm.cpu, 2)} ms CPU per round-trip; Bun.SQL ${fmt(probe.bunSql.wall, 2)} ms wall, ${fmt(probe.bunSql.cpu, 2)} ms CPU`,
  );
  lines.push("", "## Methodology", "");
  lines.push(`- Fresh database and queues per scenario; ${WALLETS} wallets + 1 hot wallet, balances large enough that no BET is rejected.`);
  lines.push(`- Mix: ${HOT_WALLET_SHARE * 100}% BET on the hot wallet, ~5% idempotent replays of earlier BETs, ~20% WIN referencing an earlier BET, rest BET on a random wallet.`);
  lines.push(`- ${WARMUP_S}s warm-up discarded, then ${DURATION_S}s measured. Latency is client-side (request sent → body read).`);
  lines.push("- Server-side figures come from each instance's /metrics (delta over the run): process CPU, lock wait histogram, lock conflicts, retries; outbox lag/pending sampled every 1s.");
  lines.push("- After the run: time for the outbox to be 100% published, and the ledger invariant checked for every wallet.");
  lines.push("", "## Results", "");
  const header = summaries.map(({ r }) => `${r.instances} inst × ${r.clients} clients`).join(" | ");
  lines.push("| | " + header + " |");
  lines.push("|---|" + summaries.map(() => "---").join("|") + "|");
  const row = (label: string, f: (x: (typeof summaries)[number]) => string) => lines.push(`| ${label} | ${summaries.map(f).join(" | ")} |`);
  row("Requests measured", ({ s }) => String(s.requests));
  row("Throughput (req/s)", ({ s }) => fmt(s.rps));
  row("Latency p50 / p95 / p99 (ms)", ({ s }) => `${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.p99)}`);
  row("Max latency (ms)", ({ s }) => fmt(s.max));
  row("Error rate (5xx + network)", ({ s }) => `${(s.errorRate * 100).toFixed(2)}%`);
  row("Status codes", ({ s }) => s.statuses.map(([k, v]) => `${k}: ${v}`).join(", "));
  row("Host CPU busy (all cores)", ({ r }) => `${(r.hostCpuBusy * 100).toFixed(0)}%`);
  row("Load generator CPU (cores)", ({ r }) => fmt(r.generatorCores, 2));
  row("CPU per instance (cores busy)", ({ s }) => s.cpuCoresPerInstance.map((c) => fmt(c, 2)).join(" / "));
  row("Server CPU per request (ms)", ({ s }) => fmt(s.cpuMsPerRequest, 2));
  row("Wallet lock wait avg / p95 / p99 (ms, bucket bound)", ({ s }) => `${fmt(s.lockWaitAvgMs, 2)} / ≤${fmt(s.lockWaitP95ms, 0)} / ≤${fmt(s.lockWaitP99ms, 0)}`);
  row("Lock conflicts (timeout/deadlock/serialization/version)", ({ s }) => String(s.lockConflicts));
  row("In-place DB retries", ({ s }) => String(s.dbRetries));
  row("Idempotent replays served", ({ s }) => String(s.replays));
  row("Outbox lag max during run (s)", ({ r }) => fmt(r.outboxLagMaxS, 2));
  row("Outbox pending max during run", ({ r }) => String(r.outboxPendingMax));
  row("Outbox drain after load (s)", ({ r }) => fmt(r.drainSeconds, 2));
  row("Ledger entries / divergences", ({ r }) => `${r.ledgerEntries} / ${r.divergences}`);
  lines.push("", "### Latency by operation (ms, p50 / p95 / p99)", "");
  lines.push("| Operation | " + header + " |");
  lines.push("|---|" + summaries.map(() => "---").join("|") + "|");
  for (const op of ["BET", "WIN", "REPLAY", "HOT_BET"] as Op[]) {
    lines.push(`| ${op} | ${summaries.map(({ s }) => { const o = s.ops.find((x) => x.op === op)!; return `${fmt(o.p50)} / ${fmt(o.p95)} / ${fmt(o.p99)} (n=${o.n})`; }).join(" | ")} |`);
  }
  const report = lines.join("\n") + "\n";
  mkdirSync("reports", { recursive: true });
  const file = `reports/load-${startedAt.toISOString().replace(/[:.]/g, "-")}.md`;
  writeFileSync(file, report);
  console.log("\n" + report);
  console.log(`[load] report written to ${file}`);
  const failed = summaries.some(({ r }) => r.divergences > 0);
  process.exit(failed ? 1 : 0);
}

await main();
