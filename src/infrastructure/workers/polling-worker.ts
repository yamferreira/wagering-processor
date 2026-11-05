import type { Logger } from "../../application/ports/logger";

export interface PollingWorkerOptions {
  name: string;
  /** Sleep between rounds when the previous round found nothing (or less than a full batch). */
  idleDelayMs: number;
  /** Cap for the backoff applied when a round throws (e.g. database unavailable). */
  maxErrorDelayMs?: number;
}

/**
 * Runs `round()` in a loop: immediately again while it reports more work, otherwise after
 * `idleDelayMs`. Errors are logged and retried with exponential backoff. `stop()` lets the
 * current round finish (rounds are single short transactions) and resolves when it did.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly round: () => Promise<{ moreWork: boolean }>,
    private readonly options: PollingWorkerOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let delay = this.options.idleDelayMs;
      try {
        const { moreWork } = await this.round();
        failures = 0;
        if (moreWork) continue;
      } catch (error) {
        failures++;
        delay = Math.min(this.options.idleDelayMs * 2 ** failures, this.options.maxErrorDelayMs ?? 10_000);
        this.logger.warn(
          { worker: this.options.name, err: error instanceof Error ? `${error.name}: ${error.message}` : String(error), delayMs: delay },
          "worker round failed",
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }
}
