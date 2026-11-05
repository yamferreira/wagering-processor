import { DeleteQueueCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/infrastructure/config/config";
import { provisionQueues, type ProvisionedQueues, type QueueTopology } from "../../src/infrastructure/messaging/sqs/queue-provisioner";
import { createSqsClient, SqsQueue } from "../../src/infrastructure/messaging/sqs/sqs.client";

const config = loadConfig();

export const SQS_ENDPOINT = config.SQS_ENDPOINT;

export function testSqsClient(requestTimeoutMs = 30_000): SQSClient {
  return createSqsClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    requestTimeoutMs,
  });
}

export interface TestQueues {
  client: SQSClient;
  topology: QueueTopology;
  urls: ProvisionedQueues;
  input: SqsQueue;
  dlq: SqsQueue;
  events: SqsQueue;
  /** Deletes the three queues and destroys the client. */
  destroy(): Promise<void>;
}

/** Real LocalStack queues, isolated per test file by a unique name prefix. */
export async function createTestQueues(
  options: { redriveMaxReceives?: number; visibilityTimeoutSeconds?: number; label?: string } = {},
): Promise<TestQueues> {
  const client = testSqsClient();
  const prefix = `t${process.pid}-${options.label ?? "q"}-${crypto.randomUUID().slice(0, 8)}`;
  const topology: QueueTopology = {
    input: `${prefix}-wager-transactions.fifo`,
    dlq: `${prefix}-wager-transactions-dlq.fifo`,
    events: `${prefix}-wagering-events.fifo`,
  };
  const urls = await provisionQueues(client, topology, {
    endpoint: config.SQS_ENDPOINT,
    redriveMaxReceives: options.redriveMaxReceives ?? 6,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 30,
  });
  return {
    client,
    topology,
    urls,
    input: new SqsQueue(client, urls.inputUrl),
    dlq: new SqsQueue(client, urls.dlqUrl),
    events: new SqsQueue(client, urls.eventsUrl),
    async destroy() {
      for (const url of [urls.inputUrl, urls.dlqUrl, urls.eventsUrl]) {
        await client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
      client.destroy();
    },
  };
}

/** Drains every visible message of a queue (receives until empty), deleting each one. */
export async function drainQueue(queue: SqsQueue, options: { idleRounds?: number; waitSeconds?: number } = {}): Promise<string[]> {
  const bodies: string[] = [];
  let idle = 0;
  while (idle < (options.idleRounds ?? 2)) {
    const batch = await queue.receive({ max: 10, waitSeconds: options.waitSeconds ?? 1 });
    if (batch.length === 0) {
      idle++;
      continue;
    }
    idle = 0;
    for (const message of batch) {
      bodies.push(message.body);
      await queue.delete(message.receiptHandle);
    }
  }
  return bodies;
}
