import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  type QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per-request timeout; must exceed the long-polling wait. */
  requestTimeoutMs?: number;
}

export function createSqsClient(options: SqsClientOptions): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: options.requestTimeoutMs ?? 30_000 },
  });
}

export interface OutgoingMessage {
  body: string;
  groupId: string;
  deduplicationId: string;
}

export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** ApproximateReceiveCount (1 on first delivery). */
  receiveCount: number;
}

export interface BatchSendResult {
  /** Indexes (in the input array) that the broker accepted. */
  succeeded: number[];
  failed: { index: number; code: string; message: string }[];
}

/** Thin, typed wrapper over one queue URL. No business logic lives here. */
export class SqsQueue {
  constructor(
    readonly client: SQSClient,
    readonly url: string,
  ) {}

  async send(message: OutgoingMessage): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
      }),
    );
    return result.MessageId ?? "";
  }

  /** Sends up to 10 messages (the SQS batch limit) in one call. */
  async sendBatch(messages: OutgoingMessage[]): Promise<BatchSendResult> {
    if (messages.length === 0) return { succeeded: [], failed: [] };
    if (messages.length > 10) throw new RangeError("SQS batches hold at most 10 messages");
    const result = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: this.url,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.deduplicationId,
        })),
      }),
    );
    return {
      succeeded: (result.Successful ?? []).map((entry) => Number(entry.Id)),
      failed: (result.Failed ?? []).map((entry) => ({
        index: Number(entry.Id),
        code: entry.Code ?? "Unknown",
        message: entry.Message ?? "",
      })),
    };
  }

  async receive(options: { max?: number; waitSeconds?: number; visibilityTimeout?: number; abortSignal?: AbortSignal } = {}): Promise<ReceivedMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: Math.min(options.max ?? 10, 10),
        WaitTimeSeconds: options.waitSeconds ?? 0,
        ...(options.visibilityTimeout !== undefined ? { VisibilityTimeout: options.visibilityTimeout } : {}),
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      options.abortSignal ? { abortSignal: options.abortSignal } : {},
    );
    return (result.Messages ?? []).map(toReceived);
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.url, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }),
    );
  }

  async attributes(names: QueueAttributeName[] = ["All"]): Promise<Record<string, string>> {
    const result = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.url, AttributeNames: names }));
    return result.Attributes ?? {};
  }

  /** Approximate visible + in-flight + delayed messages (eventually consistent). */
  async approximateDepth(): Promise<{ visible: number; inFlight: number; delayed: number }> {
    const attributes = await this.attributes([
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed",
    ]);
    return {
      visible: Number(attributes.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0),
    };
  }
}

function toReceived(message: Message): ReceivedMessage {
  return {
    messageId: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
  };
}
