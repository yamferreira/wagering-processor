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
  /** String message attributes (e.g. failure classification on DLQ moves). */
  attributes?: Record<string, string>;
}

export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** ApproximateReceiveCount (1 on first delivery). */
  receiveCount: number;
  groupId: string;
  attributes: Record<string, string>;
}

export interface BatchSendResult {
  /** Indexes (in the input array) that the broker accepted. */
  succeeded: number[];
  failed: { index: number; code: string; message: string }[];
}

/** Thin, typed wrapper over one queue URL. No business logic lives here. */
export class SqsQueue {
  private resolved: string | undefined;
  private resolving: Promise<string> | undefined;

  /**
   * `url` may be a resolver (e.g. GetQueueUrl by name) so a process can boot while SQS is down;
   * the URL is resolved on first use and cached (a failed resolution is retried next time).
   */
  constructor(
    readonly client: SQSClient,
    private readonly url: string | (() => Promise<string>),
  ) {
    if (typeof url === "string") this.resolved = url;
  }

  async queueUrl(): Promise<string> {
    if (this.resolved) return this.resolved;
    this.resolving ??= (this.url as () => Promise<string>)().then(
      (value) => (this.resolved = value),
      (error) => {
        this.resolving = undefined;
        throw error;
      },
    );
    return this.resolving;
  }

  async send(message: OutgoingMessage): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
        ...(message.attributes ? { MessageAttributes: toMessageAttributes(message.attributes) } : {}),
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
        QueueUrl: await this.queueUrl(),
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.deduplicationId,
          ...(message.attributes ? { MessageAttributes: toMessageAttributes(message.attributes) } : {}),
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
        QueueUrl: await this.queueUrl(),
        MaxNumberOfMessages: Math.min(options.max ?? 10, 10),
        WaitTimeSeconds: options.waitSeconds ?? 0,
        ...(options.visibilityTimeout !== undefined ? { VisibilityTimeout: options.visibilityTimeout } : {}),
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["All"],
      }),
      options.abortSignal ? { abortSignal: options.abortSignal } : {},
    );
    return (result.Messages ?? []).map(toReceived);
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }),
    );
  }

  async attributes(names: QueueAttributeName[] = ["All"]): Promise<Record<string, string>> {
    const result = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(), AttributeNames: names }));
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
    groupId: message.Attributes?.MessageGroupId ?? "",
    attributes: Object.fromEntries(
      Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [key, value.StringValue ?? ""]),
    ),
  };
}

function toMessageAttributes(attributes: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, { DataType: "String", StringValue: value }]),
  );
}
