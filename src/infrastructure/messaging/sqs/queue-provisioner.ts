import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type QueueAttributeName,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

export interface QueueTopology {
  input: string;
  dlq: string;
  events: string;
}

export interface ProvisionOptions {
  /** Configured SQS endpoint; returned URLs are rewritten onto it (see normalizeQueueUrl). */
  endpoint: string;
  /** Redrive maxReceiveCount on the input queue (broker safety net, A27). */
  redriveMaxReceives: number;
  visibilityTimeoutSeconds: number;
}

export interface ProvisionedQueues {
  inputUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  dlqArn: string;
}

/**
 * Creates (or converges) the FIFO topology:
 *   wager-transactions.fifo  --redrive(maxReceiveCount)-->  wager-transactions-dlq.fifo
 *   wagering-events.fifo     (outbox destination, A24)
 * Idempotent: running it twice converges attributes instead of failing.
 */
export async function provisionQueues(client: SQSClient, topology: QueueTopology, options: ProvisionOptions): Promise<ProvisionedQueues> {
  const dlqUrl = normalizeQueueUrl(
    options.endpoint,
    await ensureQueue(client, topology.dlq, { MessageRetentionPeriod: String(14 * 24 * 3600) }),
  );
  const dlqArn = await queueArn(client, dlqUrl);
  const inputUrl = normalizeQueueUrl(
    options.endpoint,
    await ensureQueue(client, topology.input, {
      VisibilityTimeout: String(options.visibilityTimeoutSeconds),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: options.redriveMaxReceives }),
    }),
  );
  const eventsUrl = normalizeQueueUrl(
    options.endpoint,
    await ensureQueue(client, topology.events, { VisibilityTimeout: String(options.visibilityTimeoutSeconds) }),
  );
  return { inputUrl, dlqUrl, eventsUrl, dlqArn };
}

async function ensureQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  // FifoQueue can only be set at creation; ContentBasedDeduplication is off because every
  // producer supplies an explicit MessageDeduplicationId (messageId / eventId).
  const creation = { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes };
  try {
    const created = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: creation }));
    return created.QueueUrl!;
  } catch (error) {
    if (!isQueueAlreadyExists(error)) throw error;
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    await client.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: attributes }));
    return QueueUrl!;
  }
}

function isQueueAlreadyExists(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "QueueAlreadyExists" || name === "QueueNameExists";
}

async function queueArn(client: SQSClient, url: string): Promise<string> {
  const attributes = await getAttributes(client, url, ["QueueArn"]);
  return attributes.QueueArn!;
}

export async function getAttributes(client: SQSClient, url: string, names: QueueAttributeName[] = ["All"]): Promise<Record<string, string>> {
  const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
  return result.Attributes ?? {};
}

export async function resolveQueueUrls(client: SQSClient, endpoint: string, topology: QueueTopology): Promise<Omit<ProvisionedQueues, "dlqArn">> {
  const url = async (name: string) => normalizeQueueUrl(endpoint, (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!);
  const [inputUrl, dlqUrl, eventsUrl] = await Promise.all([url(topology.input), url(topology.dlq), url(topology.events)]);
  return { inputUrl, dlqUrl, eventsUrl };
}

/**
 * LocalStack answers with virtual-host URLs (sqs.<region>.localhost.localstack.cloud) that
 * only resolve through public DNS. Keep the path (/<account>/<queue>) and use the configured
 * endpoint, so nothing depends on external DNS. Against real AWS the endpoint is the regional
 * SQS host, so the rewrite is a no-op in practice.
 */
export function normalizeQueueUrl(endpoint: string, queueUrl: string): string {
  const base = new URL(endpoint);
  const queue = new URL(queueUrl);
  return `${base.origin}${queue.pathname}`;
}
