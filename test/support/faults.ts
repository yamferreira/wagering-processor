import type { FaultInjector, FaultPoint } from "../../src/application/ports/fault-injector";

/** Test fault injector: arm a point to throw (or delay) the next N times it is reached. */
export class ScriptedFaults implements FaultInjector {
  private readonly armed = new Map<FaultPoint, { times: number; action: () => Promise<void> | void }>();
  readonly hits: FaultPoint[] = [];

  arm(point: FaultPoint, action: () => Promise<void> | void, times = 1): this {
    this.armed.set(point, { times, action });
    return this;
  }

  throwAt(point: FaultPoint, makeError: () => Error, times = 1): this {
    return this.arm(
      point,
      () => {
        throw makeError();
      },
      times,
    );
  }

  reset(): void {
    this.armed.clear();
    this.hits.length = 0;
  }

  async checkpoint(point: FaultPoint): Promise<void> {
    this.hits.push(point);
    const entry = this.armed.get(point);
    if (!entry || entry.times <= 0) return;
    entry.times -= 1;
    await entry.action();
  }
}
