import type { MikroORM } from "@mikro-orm/postgresql";
import type { SqsQueue } from "../messaging/sqs/sqs.client";

export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

/**
 * Readiness (§9: "PostgreSQL e SQS alcançáveis"). Each check is a cheap round-trip; the
 * controller applies a per-check timeout and reports every dependency separately.
 * Liveness has no checks at all: a dependency outage must not get a healthy process restarted.
 */
export function readinessChecks(deps: { orm: MikroORM; input: SqsQueue }): HealthCheck[] {
  return [
    {
      name: "postgres",
      check: async () => {
        await deps.orm.em.fork().execute("SELECT 1");
      },
    },
    {
      name: "sqs",
      check: async () => {
        // Resolves the queue URL on first use and proves the input queue exists and answers.
        await deps.input.attributes(["QueueArn"]);
      },
    },
  ];
}
