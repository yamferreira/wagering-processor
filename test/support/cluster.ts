import type { AppConfig } from "../../src/infrastructure/config/config";
import { type Instance, spawnInstance } from "./instances";
import type { MessagingHarness } from "./messaging";

/** Child-process configuration sharing the harness database and queues (all roles by default). */
export function instanceConfig(h: MessagingHarness, extra: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    ...h.config,
    PORT: 0,
    ROLES: ["api", "consumer", "publisher", "pending-worker"],
    LOG_LEVEL: "info",
    DB_POOL_MAX: 10,
    FAULTS: "",
    ...extra,
  };
}

/** Spawns `count` real instances in parallel and waits for all of them to be ready. */
export async function spawnCluster(
  h: MessagingHarness,
  count: number,
  extra: (index: number) => Partial<AppConfig> = () => ({}),
): Promise<Instance[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) => spawnInstance({ name: `instance-${i + 1}`, config: instanceConfig(h, extra(i)) })),
  );
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
