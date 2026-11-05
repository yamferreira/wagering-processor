import { InvariantViolationError, ValidationError } from "../errors";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/**
 * Record of a consumed message, unique by (consumerName, messageId) in the database.
 * Written in the same SQL transaction as the effects of the message.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId) throw new ValidationError("messageId is required", "messageId");
    if (!props.consumerName) throw new ValidationError("consumerName is required", "consumerName");
    if (!props.payloadHash) throw new ValidationError("payloadHash is required", "payloadHash");
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt.getTime()));
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvariantViolationError(`Inbox message ${this.consumerName}/${this.messageId} already processed`);
    }
    this._processedAt = new Date(at.getTime());
  }
}
