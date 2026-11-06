/**
 * Named points inside critical flows where tests can inject failures (crash, error, delay)
 * to prove atomicity and recovery. Production wiring uses the no-op implementation.
 */
export type FaultPoint =
  | "submit:after-transaction-insert"
  | "submit:after-ledger-insert"
  | "submit:before-outbox-insert"
  | "submit:after-commit"
  | "pending:before-apply"
  | "consumer:after-inbox-insert"
  | "consumer:after-commit-before-ack"
  | "outbox:after-claim-before-publish"
  | "outbox:after-publish-before-mark";

export interface FaultInjector {
  checkpoint(point: FaultPoint): Promise<void>;
}

export const noFaults: FaultInjector = { checkpoint: async () => {} };

/** Simulates an abrupt failure (e.g. the process dying) at a fault point. Never recorded as FAILED. */
export class InjectedFaultError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Injected fault at ${point}`);
    this.name = "InjectedFaultError";
  }
}
