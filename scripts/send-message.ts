import { loadConfig } from "../src/infrastructure/config/config";
import { resolveQueueUrls } from "../src/infrastructure/messaging/sqs/queue-provisioner";
import { createSqsClient, SqsQueue } from "../src/infrastructure/messaging/sqs/sqs.client";

/**
 * `bun run sqs:send <envelope.json> [walletId=… playerId=… …]` — sends a WagerTransactionRequested
 * envelope (§10) to the input queue. key=value arguments override fields of `data`; a fresh
 * messageId is generated unless the file sets one and `--keep-id` is passed.
 */
const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run sqs:send <envelope.json> [field=value ...] [--keep-id]");
  process.exit(2);
}
const envelope = JSON.parse(await Bun.file(file).text()) as { messageId?: string; data: Record<string, unknown> };
for (const arg of rest.filter((a) => a.includes("="))) {
  const [key, ...value] = arg.split("=");
  envelope.data[key!] = value.join("=");
}
if (!rest.includes("--keep-id")) envelope.messageId = `msg-${crypto.randomUUID()}`;

const config = loadConfig();
const client = createSqsClient({
  endpoint: config.SQS_ENDPOINT,
  region: config.AWS_REGION,
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
});
const { inputUrl } = await resolveQueueUrls(client, config.SQS_ENDPOINT, {
  input: config.SQS_INPUT_QUEUE,
  dlq: config.SQS_DLQ,
  events: config.SQS_EVENTS_QUEUE,
});
await new SqsQueue(client, inputUrl).send({
  body: JSON.stringify(envelope),
  groupId: String(envelope.data.walletId ?? "default"),
  deduplicationId: envelope.messageId!,
});
console.log(JSON.stringify({ sent: envelope.messageId, queue: config.SQS_INPUT_QUEUE }));
client.destroy();
