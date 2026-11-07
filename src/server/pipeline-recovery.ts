import type pg from 'pg';
import { markGap } from './projection.js';
import { kafka, topics } from './broker.js';

export interface OffsetBounds { low: string; high: string; }
export async function alignPartition(client: pg.PoolClient, topic: string, partition: number, bounds: OffsetBounds) {
  await client.query('SELECT pg_advisory_xact_lock(708020)');
  const checkpoint = (await client.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1 AND partition_id=$2', [topic, partition])).rows[0];
  const expected = checkpoint ? BigInt(checkpoint.next_offset) : BigInt(bounds.low);
  const gap = !!checkpoint && (expected < BigInt(bounds.low) || expected > BigInt(bounds.high));
  const offset = String(gap ? BigInt(bounds.low) : expected);
  if (gap) {
    await markGap(client, topic, `retention/log gap: checkpoint ${expected}, retained [${bounds.low},${bounds.high})`);
    const source = topic === topics.predictions ? 'predictions' : topic === topics.alerts ? 'alerts' : null;
    if (source) {
      await client.query('DELETE FROM snapshot_staging WHERE source=$1', [source]);
      await client.query('DELETE FROM snapshot_catalog WHERE topic=$1', [topic]);
    }
  }
  await client.query(`INSERT INTO projection_checkpoints(topic,partition_id,next_offset) VALUES($1,$2,$3)
    ON CONFLICT(topic,partition_id) DO UPDATE SET next_offset=EXCLUDED.next_offset,updated_at=now()`, [topic, partition, offset]);
  return { offset, gap };
}
export async function retainedSnapshots(db: pg.Pool | pg.PoolClient) {
  const admin = kafka.admin(); await admin.connect();
  try {
    const result = [];
    for (const [source, topic] of Object.entries(topics)) {
      if (source === 'commands') continue;
      const [bounds] = await admin.fetchTopicOffsets(topic);
      const snapshots = await db.query(`SELECT snapshot_id,observed_at,first_offset::text,end_offset::text
        FROM snapshot_catalog WHERE source=$1 AND topic=$2 AND partition_id=0 AND first_offset >= $3 AND end_offset < $4
        ORDER BY first_offset LIMIT 1`, [source, topic, bounds.low, bounds.high]);
      result.push({ source, lowOffset: bounds.low, highOffset: bounds.high, earliestCompleteSnapshot: snapshots.rows[0] ?? null });
    }
    return result;
  } finally { await admin.disconnect(); }
}
