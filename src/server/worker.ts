import { pathToFileURL } from 'node:url';
import { kafka, topics, ensureTopics } from './broker.js';
import { pool, transaction } from './db.js';
import { migrate } from './migrate.js';
import { cleanProjectionStorage, markGap, OffsetGapError, processRecord, quarantineRecord, type RecordPosition } from './projection.js';
import { RecordValidationError } from './snapshots.js';
import { alignPartition } from './pipeline-recovery.js';

export async function withHeartbeats<T>(work: () => Promise<T>, heartbeat: () => Promise<void>, intervalMs = 3000): Promise<T> {
  await heartbeat();
  let pending: Promise<void> | undefined, heartbeatFailed = false, heartbeatFailure: unknown;
  const timer = setInterval(() => {
    if (pending || heartbeatFailed) return;
    pending = Promise.resolve().then(heartbeat).catch(error => {
      heartbeatFailed = true; heartbeatFailure = error;
    }).finally(() => { pending = undefined; });
  }, intervalMs);
  try {
    const result = await work();
    clearInterval(timer);
    await pending;
    if (heartbeatFailed) throw heartbeatFailure;
    return result;
  } finally {
    // Let an outstanding database operation settle before surfacing lost membership.
    clearInterval(timer);
    await pending;
  }
}

export async function runWorker() {
  await migrate(); await ensureTopics();
  const modulePath = './journeys.js';
  const { refreshJourneys } = await import(modulePath) as { refreshJourneys: () => Promise<void> };
  const consumer = kafka.consumer({ groupId: 'hopahead-projection-v1', sessionTimeout: 60000,
    heartbeatInterval: 3000, maxBytesPerPartition: 2 * 1024 * 1024, allowAutoTopicCreation: false });
  const admin = kafka.admin();
  await admin.connect(); await consumer.connect();
  let alignment = Promise.resolve(), stopping = false, refreshing = false;
  const align = async (assignment: Record<string, number[]>) => {
    for (const [topic, partitions] of Object.entries(assignment)) {
      const bounds = await admin.fetchTopicOffsets(topic);
      for (const partition of partitions) {
        const boundary = bounds.find(b => b.partition === partition);
        if (!boundary) throw new Error('missing Kafka partition bounds');
        const next = await transaction(client => alignPartition(client, topic, partition, boundary));
        consumer.seek({ topic, partition, offset: next.offset });
        console.log(JSON.stringify({ event: next.gap ? 'retention_gap_baseline_requested' : 'partition_restored', topic, partition, ...next }));
      }
    }
  };
  consumer.on(consumer.events.GROUP_JOIN, event => {
    alignment = align(event.payload.memberAssignment);
    alignment.catch(error => { console.error(JSON.stringify({ event: 'alignment_failed', error: error.message })); void stop(); });
  });
  const refresh = async () => {
    if (refreshing || stopping) return;
    refreshing = true;
    try { await refreshJourneys(); }
    finally { refreshing = false; }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    await consumer.stop();
  };
  const timer = setInterval(() => {
    void refresh().catch(error => console.error(JSON.stringify({ event: 'journey_refresh_failed', error: error.message })));
  }, 15000);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let maintenanceAt = 0;
  try {
    await consumer.subscribe({ topics: Object.values(topics), fromBeginning: true });
    await consumer.run({ autoCommit: false, eachBatchAutoResolve: false, partitionsConsumedConcurrently: 1,
      eachBatch: async ({ batch, heartbeat, isRunning, isStale, resolveOffset }) => {
        const aligned = await withHeartbeats(async () => {
          await alignment;
          const checkpoint = (await pool.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1 AND partition_id=$2', [batch.topic, batch.partition])).rows[0];
          if (checkpoint) {
            const bound = (await admin.fetchTopicOffsets(batch.topic)).find(b => b.partition === batch.partition)!;
            if (BigInt(checkpoint.next_offset) < BigInt(bound.low) || BigInt(checkpoint.next_offset) > BigInt(bound.high)) {
              await align({ [batch.topic]: [batch.partition] });
              return false;
            }
          }
          return true;
        }, heartbeat);
        if (!aligned) return;
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || stopping) return;
          const position: RecordPosition = { topic: batch.topic, partition: batch.partition, offset: message.offset,
            capturedAt: new Date(Number(message.timestamp)).toISOString() };
          const text = message.value?.toString('utf8') ?? '';
          const processed = await withHeartbeats(async () => {
            let refreshNeeded = false;
            try {
              const result = await transaction(client => processRecord(client, position, text));
              refreshNeeded = result.activated || result.kind === 'manifest' || result.kind === 'journey-command';
            } catch (error) {
              if (error instanceof OffsetGapError) {
                await transaction(client => markGap(client, batch.topic, error.message));
                const [bounds] = (await admin.fetchTopicOffsets(batch.topic)).filter(b => b.partition === batch.partition);
                await align({ [batch.topic]: [batch.partition] });
                console.error(JSON.stringify({ event: 'offset_gap_recovery', topic: batch.topic, low: bounds.low, high: bounds.high }));
                return false;
              }
              // PostgreSQL/transport failures must retry delivery, never become poison-data skips.
              if (!(error instanceof RecordValidationError)) throw error;
              await transaction(client => quarantineRecord(client, position, text, error.message));
              console.error(JSON.stringify({ event: 'record_quarantined', ...position, error: error.message }));
              refreshNeeded = true;
            }
            if (refreshNeeded) await refresh();
            return true;
          }, heartbeat);
          if (!processed || !isRunning() || isStale()) return;
          await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: String(BigInt(message.offset) + 1n) }]);
          resolveOffset(message.offset);
          if (Date.now() - maintenanceAt > 60000) {
            await withHeartbeats(() => transaction(cleanProjectionStorage), heartbeat); maintenanceAt = Date.now();
          }
        }
      } });
    await new Promise<void>((resolve, reject) => {
      consumer.on(consumer.events.STOP, () => resolve());
      consumer.on(consumer.events.CRASH, event => { if (!event.payload.restart) reject(event.payload.error); });
    });
  } finally {
    clearInterval(timer); process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await consumer.disconnect(); await admin.disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runWorker(); } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await pool.end(); }
}
