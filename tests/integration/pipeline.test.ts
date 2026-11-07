import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { makeSnapshot } from '../../src/server/snapshots.js';
import { loadTransit, processRecord } from '../../src/server/projection.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const schema = `pipeline_test_${process.pid}`;
let client: pg.PoolClient;
let offset = 0;
const meta = { source: 'predictions' as const, generation: 1, revision: 1, observedAt: '2026-11-06T10:00:00Z', lastModified: null };
const prediction = (id = 'p1', arrival = '2026-11-06T10:05:00Z') => ({ type: 'prediction', id, attributes: { arrival_time: arrival, departure_time: null, stop_sequence: 10, direction_id: 0 }, relationships: { trip: { data: { id: 'trip-a' } }, route: { data: { id: 'Red' } }, stop: { data: { id: '70075' } } } });
async function deliver(record: unknown, forcedOffset?: number) {
  await client.query('BEGIN');
  try {
    const result = await processRecord(client, { topic: 'hopahead.mbta.predictions.v1', partition: 0, offset: String(forcedOffset ?? offset++), capturedAt: '2026-11-06T10:00:01Z' }, JSON.stringify(record));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
before(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(await readFile(new URL('../../src/server/schema.sql', import.meta.url), 'utf8'));
});
after(async () => {
  if (client) { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(); }
  await pool.end();
});
test('missing manifest and duplicate chunks never expose partial state; commit-before-offset retry is idempotent', async () => {
  const records = makeSnapshot({ data: [prediction()] }, meta);
  await deliver(records[0]);
  assert.equal((await loadTransit(client)).predictions.length, 0);
  await deliver(records[0]);
  assert.equal((await loadTransit(client)).predictions.length, 0);
  const result = await deliver(records.at(-1));
  assert.equal(result.activated, true);
  assert.equal((await loadTransit(client)).predictions.length, 1);
  const originalHealth = (await loadTransit(client)).predictionHealth;
  const duplicate = await deliver(records.at(-1), offset - 1);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual((await loadTransit(client)).predictionHealth, originalHealth);
  const receiptCount = await client.query('SELECT count(*)::int n FROM processed_messages');
  assert.equal(receiptCount.rows[0].n, 2);
});
test('unchanged records are not rewritten; removals happen only on validated completion', async () => {
  const before = await client.query("SELECT xmin::text FROM current_predictions WHERE id='p1'");
  const records = makeSnapshot({ data: [prediction()] }, { ...meta, revision: 2 });
  for (const record of records) await deliver(record);
  const after = await client.query("SELECT xmin::text FROM current_predictions WHERE id='p1'");
  assert.equal(after.rows[0].xmin, before.rows[0].xmin);
  const empty = makeSnapshot({ data: [] }, { ...meta, revision: 3 });
  await deliver(empty[0]);
  assert.equal((await loadTransit(client)).predictions.length, 1);
  await deliver(empty.at(-1));
  assert.equal((await loadTransit(client)).predictions.length, 0);
});
test('newer generation wins even if old observations arrive later', async () => {
  for (const r of makeSnapshot({ data: [prediction('new')] }, { ...meta, generation: 2, revision: 1 })) await deliver(r);
  for (const r of makeSnapshot({ data: [prediction('old')] }, { ...meta, generation: 1, revision: 99 })) await deliver(r);
  assert.deepEqual((await loadTransit(client)).predictions.map(p => p.id), ['new']);
});
test('database rollback removes both receipt and effects', async () => {
  const record = makeSnapshot({ data: [] }, { ...meta, generation: 2, revision: 2 })[0];
  await client.query('BEGIN');
  await processRecord(client, { topic: 'hopahead.mbta.predictions.v1', partition: 0, offset: String(offset), capturedAt: '2026-11-06T10:00:01Z' }, JSON.stringify(record));
  await client.query('ROLLBACK');
  const receipts = await client.query('SELECT count(*)::int n FROM processed_messages WHERE message_id=$1', [record.messageId]);
  assert.equal(receipts.rows[0].n, 0);
  const chunks = await client.query('SELECT count(*)::int n FROM snapshot_chunks WHERE snapshot_id=$1', [record.snapshotId]);
  assert.equal(chunks.rows[0].n, 0);
});
test('incomplete manifests and reused message identities cannot advance a snapshot', async () => {
  const records = makeSnapshot({ data: [prediction('missing')] }, { ...meta, generation: 2, revision: 3 });
  const incomplete = await deliver(records.at(-1));
  assert.equal(incomplete.activated, false);
  assert.deepEqual((await loadTransit(client)).predictions.map(p => p.id), ['new']);
  await deliver(records[0]);
  assert.deepEqual((await loadTransit(client)).predictions.map(p => p.id), ['missing']);
  const conflict = makeSnapshot({ data: [prediction('conflicting')] }, { ...meta, generation: 2, revision: 3 });
  await assert.rejects(deliver(conflict[0]), /message identity conflict/);
  offset--;
});
test('an unexpected offset jump is explicit instead of silently skipping history', async () => {
  const record = makeSnapshot({ data: [] }, { ...meta, generation: 3, revision: 1 })[0];
  await assert.rejects(deliver(record, offset + 10), /offset gap/);
});
test('serving route filters avoid returning unrelated citywide predictions', async () => {
  const all=await loadTransit(client);
  assert.ok(all.predictions.length>0);
  const scoped=await loadTransit(client,['Green-B']);
  assert.deepEqual(scoped.predictions,[]);
  assert.deepEqual(scoped.predictionHealth,all.predictionHealth);
  assert.deepEqual((await loadTransit(client,['Red'])).predictions,all.predictions);
});

test('retention loss is visible until a validated fresh baseline replaces it', async () => {
  const { alignPartition } = await import('../../src/server/pipeline-recovery.js');
  await client.query('BEGIN');
  const next = await alignPartition(client, 'hopahead.mbta.predictions.v1', 0, { low: String(offset + 100), high: String(offset + 200) });
  await client.query('COMMIT');
  assert.equal(next.offset, String(offset + 100));
  assert.equal(next.gap, true);
  const stale = await loadTransit(client);
  assert.equal(stale.predictionHealth, null);
  assert.equal(stale.predictions[0].id, 'missing');
  offset += 100;
  for (const record of makeSnapshot({ data: [prediction('recovered')] }, { ...meta, generation: 3, revision: 2 })) await deliver(record);
  assert.equal((await loadTransit(client)).predictions[0].id, 'recovered');
  assert.ok((await loadTransit(client)).predictionHealth);
});

test('quarantine is durable before offset advancement and removes positive source health', async () => {
  const { quarantineRecord } = await import('../../src/server/projection.js');
  const position = { topic: 'hopahead.mbta.predictions.v1', partition: 0, offset: String(offset), capturedAt: '2026-11-06T10:00:00Z' };
  await client.query('BEGIN');
  await quarantineRecord(client, position, '{broken', 'invalid record JSON');
  await client.query('COMMIT');
  const q = await client.query('SELECT reason FROM quarantine WHERE offset_id=$1', [position.offset]);
  assert.equal(q.rows[0].reason, 'invalid record JSON');
  const checkpoint = await client.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1', [position.topic]);
  assert.equal(checkpoint.rows[0].next_offset, String(offset + 1));
  assert.equal((await loadTransit(client)).predictionHealth, null);
});

test('a command retention gap leaves in-progress alert snapshots intact', async () => {
  const { alignPartition } = await import('../../src/server/pipeline-recovery.js');
  const alertChunk = makeSnapshot({ data: [] }, { ...meta, source: 'alerts' })[0];
  await client.query('BEGIN');
  await processRecord(client, { topic: 'hopahead.mbta.alerts.v1', partition: 0, offset: '0', capturedAt: '2026-11-06T10:00:01Z' }, JSON.stringify(alertChunk));
  await client.query("INSERT INTO projection_checkpoints(topic,partition_id,next_offset) VALUES('hopahead.journey.commands.v1',0,0)");
  await client.query('COMMIT');
  await client.query('BEGIN');
  const next = await alignPartition(client, 'hopahead.journey.commands.v1', 0, { low: '10', high: '20' });
  await client.query('COMMIT');
  assert.equal(next.gap, true);
  const staged = await client.query('SELECT snapshot_id FROM snapshot_staging WHERE snapshot_id=$1', [alertChunk.snapshotId]);
  assert.equal(staged.rowCount, 1, 'recovering commands must not delete an alert snapshot');
  const chunks = await client.query('SELECT chunk_index FROM snapshot_chunks WHERE snapshot_id=$1', [alertChunk.snapshotId]);
  assert.equal(chunks.rowCount, 1);
});

test('an overflowing stop sequence goes through quarantine instead of a PostgreSQL retry loop', async () => {
  const { RecordValidationError } = await import('../../src/server/snapshots.js');
  const { quarantineRecord } = await import('../../src/server/projection.js');
  const p = prediction('overflow'); p.attributes.stop_sequence = 2147483648;
  const records = makeSnapshot({ data: [p] }, { ...meta, generation: 4, revision: 1 });
  const topic = 'hopahead.mbta.predictions.v1';
  for (const record of records) {
    const checkpoint = (await client.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1', [topic])).rows[0];
    const position = { topic, partition: 0, offset: checkpoint.next_offset, capturedAt: '2026-11-06T10:00:01Z' };
    await client.query('BEGIN');
    if (record.kind === 'chunk') {
      await processRecord(client, position, JSON.stringify(record));
      await client.query('COMMIT');
    } else {
      await assert.rejects(processRecord(client, position, JSON.stringify(record)), RecordValidationError);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await quarantineRecord(client, position, JSON.stringify(record), 'invalid stop_sequence');
      await client.query('COMMIT');
      const quarantined = await client.query('SELECT reason FROM quarantine WHERE topic=$1 AND offset_id=$2', [topic, position.offset]);
      assert.equal(quarantined.rows[0].reason, 'invalid stop_sequence');
      const advanced = (await client.query('SELECT next_offset FROM projection_checkpoints WHERE topic=$1', [topic])).rows[0];
      assert.equal(advanced.next_offset, String(BigInt(position.offset) + 1n));
    }
  }
  assert.deepEqual((await loadTransit(client)).predictions.map(p => p.id), ['recovered']);
});
