import type pg from 'pg';
import type { SourceHealth, TransitState } from '../shared/contracts.js';
import { normalizeAlerts, normalizePredictions } from './normalize.js';
import { RecordValidationError, digest, parseRecord, restoreSnapshot, type FeedRecord, type ManifestRecord, type Source, type WireRecord } from './snapshots.js';

export interface RecordPosition { topic: string; partition: number; offset: string; capturedAt: string; }
export interface ProcessResult { activated: boolean; duplicate: boolean; kind: WireRecord['kind']; }
export class OffsetGapError extends Error {}

export async function loadTransit(db: pg.Pool | pg.PoolClient, routes: string[] | null = null): Promise<TransitState> {
  // One SQL statement gives callers a consistent MVCC snapshot of rows and health.
  const result = await db.query(`SELECT
    COALESCE((SELECT jsonb_agg(payload ORDER BY id) FROM current_predictions WHERE $1::text[] IS NULL OR route_id=ANY($1::text[])),'[]'::jsonb) predictions,
    COALESCE((SELECT jsonb_agg(payload ORDER BY id) FROM current_alerts),'[]'::jsonb) alerts,
    (SELECT health FROM source_health WHERE source='predictions' AND NOT EXISTS (SELECT 1 FROM source_gaps WHERE source='predictions')) "predictionHealth",
    (SELECT health FROM source_health WHERE source='alerts' AND NOT EXISTS (SELECT 1 FROM source_gaps WHERE source='alerts')) "alertHealth"`, [routes]);
  return result.rows[0] as TransitState;
}
function fingerprint(record: WireRecord): string {
  if (record.kind === 'journey-command') return digest(JSON.stringify([record.kind, record.messageId, record.journeyId, record.revision]));
  return digest(JSON.stringify([record.kind, record.snapshotId, record.observedAt, record.lastModified, record.digest,
    record.rawBytes, record.compressedBytes, record.chunkCount, record.kind === 'chunk' ? record.index : null,
    record.kind === 'chunk' ? record.data : null]));
}
function metadata(record: FeedRecord) {
  return { schemaVersion: record.schemaVersion, source: record.source, generation: record.generation, revision: record.revision,
    observedAt: record.observedAt, lastModified: record.lastModified, snapshotId: record.snapshotId,
    encoding: record.encoding, chunkCount: record.chunkCount, compressedBytes: record.compressedBytes,
    rawBytes: record.rawBytes, digest: record.digest };
}
async function upsertPredictions(client: pg.PoolClient, document: unknown) {
  const rows = normalizePredictions(document);
  const result = await client.query(`INSERT INTO current_predictions
    (id,trip_id,route_id,stop_id,stop_sequence,direction,arrival_time,departure_time,schedule_relationship,payload)
    SELECT x->>'id',x->>'tripId',x->>'routeId',x->>'stopId',(x->>'sequence')::int,(x->>'direction')::int,
      (x->>'arrivalTime')::timestamptz,(x->>'departureTime')::timestamptz,x->>'scheduleRelationship',x
    FROM jsonb_array_elements($1::jsonb) x
    ON CONFLICT(id) DO UPDATE SET trip_id=EXCLUDED.trip_id,route_id=EXCLUDED.route_id,stop_id=EXCLUDED.stop_id,
      stop_sequence=EXCLUDED.stop_sequence,direction=EXCLUDED.direction,arrival_time=EXCLUDED.arrival_time,
      departure_time=EXCLUDED.departure_time,schedule_relationship=EXCLUDED.schedule_relationship,payload=EXCLUDED.payload
    WHERE current_predictions.payload IS DISTINCT FROM EXCLUDED.payload`, [JSON.stringify(rows)]);
  const removed = await client.query('DELETE FROM current_predictions WHERE NOT(id=ANY($1::text[]))', [rows.map(r => r.id)]);
  return { count: rows.length, changed: result.rowCount, removed: removed.rowCount };
}
async function upsertAlerts(client: pg.PoolClient, document: unknown) {
  const rows = normalizeAlerts(document);
  const result = await client.query(`INSERT INTO current_alerts(id,effect,payload)
    SELECT x->>'id',x->>'effect',x FROM jsonb_array_elements($1::jsonb) x
    ON CONFLICT(id) DO UPDATE SET effect=EXCLUDED.effect,payload=EXCLUDED.payload
    WHERE current_alerts.payload IS DISTINCT FROM EXCLUDED.payload`, [JSON.stringify(rows)]);
  const removed = await client.query('DELETE FROM current_alerts WHERE NOT(id=ANY($1::text[]))', [rows.map(r => r.id)]);
  return { count: rows.length, changed: result.rowCount, removed: removed.rowCount };
}
async function stage(client: pg.PoolClient, record: FeedRecord, position: RecordPosition): Promise<boolean> {
  const health = (await client.query('SELECT generation,revision FROM source_health WHERE source=$1', [record.source])).rows[0];
  const lease = (await client.query('SELECT generation FROM collector_generations WHERE source=$1', [record.source])).rows[0];
  if (lease && record.generation < lease.generation) return false;
  if (health && (record.generation < health.generation || (record.generation === health.generation && record.revision <= Number(health.revision)))) return false;
  const meta = JSON.stringify(metadata(record));
  await client.query(`INSERT INTO snapshot_staging(snapshot_id,source,metadata,first_offset) VALUES($1,$2,$3,$4)
    ON CONFLICT(snapshot_id) DO NOTHING`, [record.snapshotId, record.source, meta, position.offset]);
  const staged = (await client.query('SELECT metadata,manifest,first_offset,metadata=$2::jsonb same FROM snapshot_staging WHERE snapshot_id=$1 FOR UPDATE', [record.snapshotId, meta])).rows[0];
  if (!staged.same) throw new RecordValidationError('snapshot metadata conflict');
  if (record.kind === 'chunk') {
    await client.query('INSERT INTO snapshot_chunks(snapshot_id,chunk_index,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [record.snapshotId, record.index, JSON.stringify(record)]);
  } else {
    await client.query('UPDATE snapshot_staging SET manifest=$2 WHERE snapshot_id=$1', [record.snapshotId, JSON.stringify(record)]);
    staged.manifest = record;
  }
  const manifest: ManifestRecord | null = staged.manifest;
  if (!manifest) return false;
  const chunks = (await client.query('SELECT payload FROM snapshot_chunks WHERE snapshot_id=$1 ORDER BY chunk_index', [record.snapshotId])).rows.map(r => r.payload);
  if (chunks.length !== manifest.chunkCount) return false;
  const document = restoreSnapshot(manifest, chunks);
  const metrics = record.source === 'predictions' ? await upsertPredictions(client, document) : await upsertAlerts(client, document);
  const projectedAt = new Date().toISOString();
  const sourceHealth: SourceHealth = { observedAt: record.observedAt, lastModified: record.lastModified,
    capturedAt: position.capturedAt, projectedAt, generation: record.generation, revision: record.revision,
    topic: position.topic, partition: position.partition, offset: position.offset };
  await client.query(`INSERT INTO source_health(source,generation,revision,health) VALUES($1,$2,$3,$4)
    ON CONFLICT(source) DO UPDATE SET generation=EXCLUDED.generation,revision=EXCLUDED.revision,health=EXCLUDED.health`,
    [record.source, record.generation, record.revision, JSON.stringify(sourceHealth)]);
  await client.query(`INSERT INTO snapshot_catalog(snapshot_id,source,topic,partition_id,first_offset,end_offset,observed_at,generation,revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [record.snapshotId, record.source, position.topic, position.partition,
    staged.first_offset, position.offset, record.observedAt, record.generation, record.revision]);
  await client.query('DELETE FROM source_gaps WHERE source=$1', [record.source]);
  await client.query('DELETE FROM snapshot_staging WHERE source=$1 AND ((metadata->>\'generation\')::int<$2 OR ((metadata->>\'generation\')::int=$2 AND (metadata->>\'revision\')::bigint<=$3))', [record.source, record.generation, record.revision]);
  await client.query("SELECT pg_notify('hopahead_transit',$1)", [record.source]);
  console.log(JSON.stringify({ event: 'snapshot_projected', source: record.source, snapshotId: record.snapshotId,
    ...metrics, lagMs: Date.parse(projectedAt) - Date.parse(record.observedAt), offset: position.offset }));
  return true;
}
export async function processRecord(client: pg.PoolClient, position: RecordPosition, text: string): Promise<ProcessResult> {
  const record = parseRecord(text);
  const expectedTopic = record.kind === 'journey-command' ? 'hopahead.journey.commands.v1' : `hopahead.mbta.${record.source}.v1`;
  if (position.topic !== expectedTopic || position.partition !== 0 || !/^\d+$/.test(position.offset)) throw new RecordValidationError('record source/position mismatch');
  await client.query('SELECT pg_advisory_xact_lock(708020)');
  const checkpoint = (await client.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1 AND partition_id=$2 FOR UPDATE', [position.topic, position.partition])).rows[0];
  if (checkpoint && BigInt(position.offset) > BigInt(checkpoint.next_offset)) throw new OffsetGapError(`offset gap on ${position.topic}: expected ${checkpoint.next_offset}, received ${position.offset}`);
  const existing = (await client.query('SELECT fingerprint FROM processed_messages WHERE message_id=$1', [record.messageId])).rows[0];
  const hash = fingerprint(record);
  if (existing && existing.fingerprint !== hash) throw new RecordValidationError('message identity conflict');
  const duplicate = !!existing || !!(checkpoint && BigInt(position.offset) < BigInt(checkpoint.next_offset));
  let activated = false;
  if (!duplicate) {
    await client.query('INSERT INTO processed_messages(message_id,fingerprint) VALUES($1,$2)', [record.messageId, hash]);
    if (record.kind !== 'journey-command') activated = await stage(client, record, position);
  }
  await client.query(`INSERT INTO projection_checkpoints(topic,partition_id,next_offset) VALUES($1,$2,$3)
    ON CONFLICT(topic,partition_id) DO UPDATE SET next_offset=GREATEST(projection_checkpoints.next_offset,EXCLUDED.next_offset),updated_at=now()`,
    [position.topic, position.partition, String(BigInt(position.offset) + 1n)]);
  return { activated, duplicate, kind: record.kind };
}
export async function markGap(client: pg.PoolClient, topic: string, reason: string) {
  const source: Source | null = topic.endsWith('predictions.v1') ? 'predictions' : topic.endsWith('alerts.v1') ? 'alerts' : null;
  if (source) await client.query('INSERT INTO source_gaps(source,reason) VALUES($1,$2) ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,requested_at=now()', [source, reason.slice(0,2048)]);
}
export async function quarantineRecord(client: pg.PoolClient, position: RecordPosition, text: string, reason: string) {
  await client.query('SELECT pg_advisory_xact_lock(708020)');
  await client.query(`INSERT INTO quarantine(topic,partition_id,offset_id,reason,payload_prefix) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(topic,partition_id,offset_id) DO NOTHING`, [position.topic, position.partition, position.offset, reason.slice(0,2048), text.slice(0,4096)]);
  await markGap(client, position.topic, reason);
  await client.query(`INSERT INTO projection_checkpoints(topic,partition_id,next_offset) VALUES($1,$2,$3)
    ON CONFLICT(topic,partition_id) DO UPDATE SET next_offset=GREATEST(projection_checkpoints.next_offset,EXCLUDED.next_offset),updated_at=now()`,
    [position.topic, position.partition, String(BigInt(position.offset) + 1n)]);
}
export async function cleanProjectionStorage(client: pg.PoolClient) {
  await client.query("DELETE FROM processed_messages WHERE processed_at<now()-interval '48 hours'");
  await client.query("DELETE FROM snapshot_staging WHERE created_at<now()-interval '30 minutes'");
  await client.query("DELETE FROM snapshot_catalog WHERE observed_at<now()-interval '48 hours'");
  await client.query("DELETE FROM quarantine WHERE created_at<now()-interval '7 days'");
}
