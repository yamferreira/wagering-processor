import { TransientInfrastructureError, TransientReason } from "../../application/errors";
import { type FaultInjector, type FaultPoint, InjectedFaultError } from "../../application/ports/fault-injector";

/**
 * Test-only fault injection for spawned processes, configured by the FAULTS env var:
 *
 *   FAULTS="consumer:after-commit-before-ack=crash*1,outbox:after-claim-before-publish=delay:500"
 *
 * Each entry is `<point>=<action>[*<times>]` (times defaults to unlimited). Actions:
 *   crash      — kill this process abruptly (SIGKILL; TerminateProcess on Windows): no cleanup,
 *                no ack, no graceful shutdown — exactly what a real crash looks like;
 *   throw      — InjectedFaultError (the unit of work is abandoned);
 *   transient  — TransientInfrastructureError (exercises retry/backoff);
 *   delay:<ms> — sleep, to widen race windows.
 * When FAULTS is empty the production no-op injector is used instead (see buildFaultInjector).
 */
type Action = { kind: "crash" } | { kind: "throw" } | { kind: "transient" } | { kind: "delay"; ms: number };

interface Rule {
  action: Action;
  remaining: number;
}

export class EnvFaultInjector implements FaultInjector {
  private readonly rules = new Map<string, Rule>();

  constructor(spec: string) {
    for (const raw of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
      const separator = raw.lastIndexOf("=");
      if (separator <= 0) throw new Error(`Invalid FAULTS entry: ${raw}`);
      const point = raw.slice(0, separator);
      const [actionSpec, timesSpec] = raw.slice(separator + 1).split("*");
      this.rules.set(point, {
        action: parseAction(actionSpec ?? ""),
        remaining: timesSpec === undefined ? Number.POSITIVE_INFINITY : Number(timesSpec),
      });
    }
  }

  get size(): number {
    return this.rules.size;
  }

  async checkpoint(point: FaultPoint): Promise<void> {
    const rule = this.rules.get(point);
    if (!rule || rule.remaining <= 0) return;
    rule.remaining -= 1;
    switch (rule.action.kind) {
      case "crash":
        process.kill(process.pid, "SIGKILL");
        // SIGKILL is asynchronous on some platforms: never let the caller continue.
        await new Promise(() => {});
        return;
      case "throw":
        throw new InjectedFaultError(point);
      case "transient":
        throw new TransientInfrastructureError(TransientReason.ConnectionFailure, `Injected transient fault at ${point}`);
      case "delay":
        await new Promise((resolve) => setTimeout(resolve, (rule.action as { ms: number }).ms));
        return;
    }
  }
}

function parseAction(spec: string): Action {
  if (spec === "crash" || spec === "throw" || spec === "transient") return { kind: spec };
  const delay = /^delay:(\d+)$/.exec(spec);
  if (delay) return { kind: "delay", ms: Number(delay[1]) };
  throw new Error(`Invalid FAULTS action: ${spec}`);
}
