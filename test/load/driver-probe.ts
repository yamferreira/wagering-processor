import { SQL } from "bun";
import { initOrm } from "../../src/infrastructure/persistence/orm";

export interface ProbeResult {
  wall: number;
  cpu: number;
}

/**
 * Cost of one database round-trip in this process: sequential SELECT 1 through MikroORM (node-postgres
 * "pg" driver, which MikroORM uses) vs Bun's native Bun.SQL. CPU ≈ wall means the process stays busy
 * while it waits for PostgreSQL instead of sleeping in the event loop.
 */
export async function driverProbe(url: string, n = 300): Promise<{ mikroOrm: ProbeResult; mikroOrmTx: ProbeResult; bunSql: ProbeResult }> {
  const measure = async (fn: () => Promise<unknown>): Promise<ProbeResult> => {
    for (let i = 0; i < 20; i++) await fn();
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await fn();
    const wall = (performance.now() - t0) / n;
    const c = process.cpuUsage(c0);
    return { wall, cpu: (c.user + c.system) / 1_000 / n };
  };
  const orm = await initOrm(url, 2);
  const sql = new SQL({ url, max: 2 });
  try {
    return {
      mikroOrm: await measure(() => orm.em.fork().execute("SELECT 1")),
      mikroOrmTx: await measure(() => orm.em.fork().transactional((em) => em.execute("SELECT 1"))),
      bunSql: await measure(() => sql`SELECT 1`),
    };
  } finally {
    await orm.close(true);
    await sql.close();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? "postgres://wagering_app:wagering_app@localhost:55432/wagering";
  const result = await driverProbe(url);
  const f = (r: ProbeResult) => `wall ${r.wall.toFixed(2)} ms, cpu ${r.cpu.toFixed(2)} ms`;
  console.log(`platform=${process.platform} bun=${Bun.version}`);
  console.log(`MikroORM/pg SELECT 1          ${f(result.mikroOrm)}`);
  console.log(`MikroORM/pg transactional     ${f(result.mikroOrmTx)}`);
  console.log(`Bun.SQL SELECT 1              ${f(result.bunSql)}`);
}
