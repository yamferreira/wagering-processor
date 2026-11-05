/** Polls `probe` until it returns a truthy value or the timeout elapses (explicit timeouts, no flakiness by sleeping). */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value as T;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${options.description ?? "condition"} (last: ${String(last)})`);
    }
    await Bun.sleep(options.intervalMs ?? 100);
  }
}

export const sleep = (ms: number) => Bun.sleep(ms);
