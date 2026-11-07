import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import { makeSnapshot, type SnapshotMeta } from './snapshots.js';

export const topics = { predictions: 'hopahead.mbta.predictions.v1', alerts: 'hopahead.mbta.alerts.v1', commands: 'hopahead.journey.commands.v1' };
export const kafka = new Kafka({ clientId: 'hopahead', brokers: (process.env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(','),
  logLevel: logLevel.WARN, connectionTimeout: 10000, requestTimeout: 30000, retry: { retries: 8 } });
export async function ensureTopics() {
  const admin = kafka.admin(); await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = Object.entries(topics).filter(([, topic]) => !existing.has(topic));
    if (missing.length) await admin.createTopics({ waitForLeaders: true, topics: missing.map(([source, topic]) => ({
      topic, numPartitions: 1, replicationFactor: 1, configEntries: [
        { name: 'cleanup.policy', value: 'delete' }, { name: 'retention.ms', value: '86400000' },
        { name: 'retention.bytes', value: String((source === 'predictions' ? 8 : 1) * 1024 ** 3) },
        { name: 'segment.bytes', value: String(64 * 1024 ** 2) }, { name: 'segment.ms', value: '900000' },
        { name: 'max.message.bytes', value: '1048588' }, { name: 'min.insync.replicas', value: '1' },
      ] })) });
    const metadata = await admin.fetchTopicMetadata({ topics: Object.values(topics) });
    if (metadata.topics.some(t => t.partitions.length !== 1)) throw new Error('source topics require one partition; migrate ordering before changing this');
  } finally { await admin.disconnect(); }
}
export async function createProducer(): Promise<Producer> {
  const producer = kafka.producer({ idempotent: true, retry: { retries: Number.MAX_SAFE_INTEGER }, maxInFlightRequests: 1, allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });
  await producer.connect();
  return producer;
}
export async function publishSnapshot(producer: Pick<Producer, 'send'>, document: unknown, meta: SnapshotMeta, assertOwnership: () => Promise<void> = async () => {}) {
  const records = makeSnapshot(document, meta);
  for (const record of records) {
    await assertOwnership();
    await producer.send({ topic: topics[meta.source], acks: -1, messages: [{ key: meta.source, partition: 0,
      value: JSON.stringify(record), timestamp: String(Date.now()) }] });
  }
  return { snapshotId: records[0].snapshotId, chunks: records.length - 1, compressedBytes: records[0].compressedBytes, rawBytes: records[0].rawBytes };
}
