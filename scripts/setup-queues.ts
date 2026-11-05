import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/infrastructure/config/config";
import { provisionQueues } from "../src/infrastructure/messaging/sqs/queue-provisioner";
import { createSqsClient } from "../src/infrastructure/messaging/sqs/sqs.client";

/** `bun run sqs:setup`: creates the FIFO topology (idempotent) and lists the queues. */
const config = loadConfig();
const client = createSqsClient({
  endpoint: config.SQS_ENDPOINT,
  region: config.AWS_REGION,
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
});

const queues = await provisionQueues(
  client,
  { input: config.SQS_INPUT_QUEUE, dlq: config.SQS_DLQ, events: config.SQS_EVENTS_QUEUE },
  { endpoint: config.SQS_ENDPOINT, redriveMaxReceives: config.SQS_REDRIVE_MAX_RECEIVES, visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_S },
);
console.log(JSON.stringify({ level: "info", msg: "queues provisioned", ...queues }));

const listed = await client.send(new ListQueuesCommand({}));
for (const url of listed.QueueUrls ?? []) console.log(url);
client.destroy();
