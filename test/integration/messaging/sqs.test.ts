import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { provisionQueues } from "../../../src/infrastructure/messaging/sqs/queue-provisioner";
import { SQS_ENDPOINT, createTestQueues, type TestQueues } from "../../support/sqs";

/**
 * T13: validates the LocalStack (4.14.0) features the consumer and the publisher rely on:
 * FIFO + explicit deduplication, ChangeMessageVisibility and redrive to the DLQ.
 */
describe("SQS adapter and queue provisioning (LocalStack)", () => {
  let queues: TestQueues;

  beforeAll(async () => {
    queues = await createTestQueues({ label: "adapter" });
  });
  afterAll(async () => {
    await queues.destroy();
  });

  test("provisioning is idempotent and wires the redrive policy to the DLQ", async () => {
    const again = await provisionQueues(queues.client, queues.topology, {
      endpoint: SQS_ENDPOINT,
      redriveMaxReceives: 6,
      visibilityTimeoutSeconds: 30,
    });
    expect(again).toEqual(queues.urls);

    const input = await queues.input.attributes();
    expect(input.FifoQueue).toBe("true");
    expect(input.ContentBasedDeduplication).toBe("false");
    expect(input.VisibilityTimeout).toBe("30");
    const redrive = JSON.parse(input.RedrivePolicy ?? "{}");
    expect(redrive.deadLetterTargetArn).toBe(queues.urls.dlqArn);
    expect(Number(redrive.maxReceiveCount)).toBe(6);

    expect((await queues.dlq.attributes()).FifoQueue).toBe("true");
    expect((await queues.events.attributes()).FifoQueue).toBe("true");
  });

  test("provisioning converges changed attributes instead of failing", async () => {
    await provisionQueues(queues.client, queues.topology, { endpoint: SQS_ENDPOINT, redriveMaxReceives: 4, visibilityTimeoutSeconds: 15 });
    const input = await queues.input.attributes();
    expect(input.VisibilityTimeout).toBe("15");
    expect(Number(JSON.parse(input.RedrivePolicy ?? "{}").maxReceiveCount)).toBe(4);
    await provisionQueues(queues.client, queues.topology, { endpoint: SQS_ENDPOINT, redriveMaxReceives: 6, visibilityTimeoutSeconds: 30 });
  });

  test("send → receive → delete roundtrip", async () => {
    const id = crypto.randomUUID();
    await queues.input.send({ body: JSON.stringify({ id }), groupId: "g1", deduplicationId: id });
    const [message] = await queues.input.receive({ waitSeconds: 2 });
    expect(message).toBeDefined();
    expect(JSON.parse(message!.body)).toEqual({ id });
    expect(message!.receiveCount).toBe(1);
    await queues.input.delete(message!.receiptHandle);
    expect(await queues.input.receive({ waitSeconds: 1 })).toHaveLength(0);
  });

  test("explicit MessageDeduplicationId drops a duplicate send (broker-level, not relied upon for correctness)", async () => {
    const id = crypto.randomUUID();
    await queues.input.send({ body: "first", groupId: "g-dedup", deduplicationId: id });
    await queues.input.send({ body: "second", groupId: "g-dedup", deduplicationId: id });
    const received = await queues.input.receive({ max: 10, waitSeconds: 2 });
    expect(received.map((m) => m.body)).toEqual(["first"]);
    await queues.input.delete(received[0]!.receiptHandle);
    expect(await queues.input.receive({ waitSeconds: 1 })).toHaveLength(0);
  });

  test("batch send reports per-entry success", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      body: `b${i}`,
      groupId: `g-batch-${i % 3}`,
      deduplicationId: crypto.randomUUID(),
    }));
    const result = await queues.input.sendBatch(messages);
    expect(result.failed).toEqual([]);
    expect(result.succeeded.sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
    const seen: string[] = [];
    for (let round = 0; round < 10 && seen.length < 10; round++) {
      for (const message of await queues.input.receive({ max: 10, waitSeconds: 1 })) {
        seen.push(message.body);
        await queues.input.delete(message.receiptHandle);
      }
    }
    expect(seen.sort()).toEqual(messages.map((m) => m.body).sort());
  });

  test("ChangeMessageVisibility: 0 makes the message visible again; N hides it for ~N seconds", async () => {
    const id = crypto.randomUUID();
    await queues.input.send({ body: "vis", groupId: "g-vis", deduplicationId: id });

    const [first] = await queues.input.receive({ waitSeconds: 2 });
    expect(first?.receiveCount).toBe(1);
    // In flight: invisible to other receivers.
    expect(await queues.input.receive({ waitSeconds: 0 })).toHaveLength(0);

    await queues.input.changeVisibility(first!.receiptHandle, 0);
    const [second] = await queues.input.receive({ waitSeconds: 2 });
    expect(second?.body).toBe("vis");
    expect(second?.receiveCount).toBe(2);

    await queues.input.changeVisibility(second!.receiptHandle, 2);
    const hiddenAt = Date.now();
    expect(await queues.input.receive({ waitSeconds: 1 })).toHaveLength(0);
    const [third] = await queues.input.receive({ waitSeconds: 5 });
    expect(third?.receiveCount).toBe(3);
    expect(Date.now() - hiddenAt).toBeGreaterThanOrEqual(1_500);
    await queues.input.delete(third!.receiptHandle);
  });

  test("a message received more than maxReceiveCount times is redriven to the DLQ", async () => {
    const redrive = await createTestQueues({ label: "redrive", redriveMaxReceives: 2, visibilityTimeoutSeconds: 30 });
    try {
      const id = crypto.randomUUID();
      await redrive.input.send({ body: "poison", groupId: "g-poison", deduplicationId: id });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const [message] = await redrive.input.receive({ waitSeconds: 2 });
        expect(message?.receiveCount).toBe(attempt);
        await redrive.input.changeVisibility(message!.receiptHandle, 0);
      }
      // Third receive exceeds maxReceiveCount=2: the broker moves it to the DLQ instead.
      expect(await redrive.input.receive({ waitSeconds: 1 })).toHaveLength(0);
      const [dead] = await redrive.dlq.receive({ waitSeconds: 3 });
      expect(dead?.body).toBe("poison");
    } finally {
      await redrive.destroy();
    }
  });
});
