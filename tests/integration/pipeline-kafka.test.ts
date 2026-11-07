import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kafka, topics, ensureTopics, createProducer, publishSnapshot } from '../../src/server/broker.js';

test('Kafka stores all snapshot chunks before its manifest and preserves source partition ordering', { timeout: 30000 }, async () => {
  await ensureTopics();
  const admin = kafka.admin(); await admin.connect();
  const testTopic = `hopahead-test-${process.pid}-${Date.now()}`;
  await admin.createTopics({ topics: [{ topic: testTopic, numPartitions: 1, replicationFactor: 1 }] });
  const before = await admin.fetchTopicOffsets(testTopic);
  const producer = await createProducer();
  const consumer = kafka.consumer({ groupId: `hopahead-pipeline-test-${process.pid}`, sessionTimeout: 10000 });
  const received: { kind: string; partition: number; offset: string }[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: testTopic, fromBeginning: true });
    await consumer.run({ autoCommit: false, eachMessage: async ({ message, partition }) => {
      if (!message.value || BigInt(message.offset) < BigInt(before[0].high)) return;
      const value = JSON.parse(message.value.toString());
      if (value.generation !== 987654) return;
      received.push({ kind: value.kind, partition, offset: message.offset });
      if (value.kind === 'manifest') finish();
    } });
    await publishSnapshot({ send: request => producer.send({ ...request, topic: testTopic }) }, { data: [] }, { source: 'alerts', generation: 987654, revision: Date.now(), observedAt: new Date().toISOString(), lastModified: null });
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('Kafka capture timeout')), 15000).unref())]);
    assert.deepEqual(received.map(r => r.kind), ['chunk', 'manifest']);
    assert.ok(received.every(r => r.partition === 0));
    assert.equal(BigInt(received[1].offset), BigInt(received[0].offset) + 1n);
  } finally {
    await consumer.disconnect(); await producer.disconnect();
    await admin.deleteGroups([`hopahead-pipeline-test-${process.pid}`]);
    await admin.deleteTopics({ topics: [testTopic] }); await admin.disconnect();
  }
});
