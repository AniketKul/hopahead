import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, cpus, platform, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { makeSnapshot, MAX_RAW_BYTES } from '../src/server/snapshots.js';
import { loadTransit, processRecord, type RecordPosition } from '../src/server/projection.js';
import { MAX_RESOURCES, normalizePredictions } from '../src/server/normalize.js';

type PredictionResource = { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, { data: { id: string; type: string } | null }> };
type Document = { data: PredictionResource[]; jsonapi?: unknown };

function amplify(document: Document, factor: number, shiftSeconds: number): Document {
  assert(Number.isSafeInteger(factor) && factor > 0 && document.data.length * factor < Math.min(100000, MAX_RESOURCES), 'synthetic resource bound');
  const data: PredictionResource[] = [];
  for (let copy = 0; copy < factor; copy++) {
    for (const original of document.data) {
      const row = structuredClone(original);
      row.id = `synthetic-${copy}-${row.id}`;
      const trip = row.relationships.trip.data;
      if (trip) trip.id = `synthetic-${copy}-${trip.id}`;
      for (const field of ['arrival_time', 'departure_time']) {
        const value = row.attributes[field];
        if (typeof value === 'string') row.attributes[field] = new Date(Date.parse(value) + shiftSeconds * (copy + 1) * 1000).toISOString();
      }
      data.push(row);
    }
  }
  return { ...document, data };
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3)) : null;
  return { samples: sorted.length, min: at(0), p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}
function selfCheck() {
  const original: Document = { data: [{ id: 'prediction-1', type: 'prediction', attributes: { arrival_time: '2026-11-06T17:00:00Z', departure_time: null }, relationships: { trip: { data: { id: 'trip-1', type: 'trip' } } } }] };
  const result = amplify(original, 3, 60);
  assert.equal(result.data.length, 3);
  assert.equal(new Set(result.data.map(row => row.id)).size, 3);
  assert.equal(new Set(result.data.map(row => row.relationships.trip.data!.id)).size, 3);
  assert.equal(result.data[0].attributes.arrival_time, '2026-11-06T17:01:00.000Z');
  assert.equal(result.data[2].attributes.arrival_time, '2026-11-06T17:03:00.000Z');
  assert.equal(result.data[0].attributes.departure_time, null);
  assert.equal(original.data[0].attributes.arrival_time, '2026-11-06T17:00:00Z');
  assert.throws(() => amplify(original, 100001, 60), /resource bound/);
  assert.deepEqual(distribution([100, 1, 2]), { samples: 3, min: 1, p50: 2, p95: 100, p99: 100, max: 100 });
  assert.deepEqual(distribution([]), { samples: 0, min: null, p50: null, p95: null, p99: null, max: null });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const topic = 'hopahead.mbta.predictions.v1';
const checksum = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const schemaName = () => `hopahead_bench_${randomUUID().replaceAll('-', '')}`;
const quoteSchema = (name: string) => {
  assert(/^hopahead_bench_[a-f0-9]{32}$/.test(name), 'refusing an unowned schema');
  return `"${name}"`;
};
async function bytes(client: pg.Client | pg.PoolClient, schema: string) {
  const row = (await client.query(`SELECT pg_current_wal_lsn()::text lsn,
    pg_database_size(current_database())::text database_bytes,
    COALESCE((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','m')),0)::text schema_bytes`, [schema])).rows[0];
  return { lsn: row.lsn as string, databaseBytes: Number(row.database_bytes), schemaBytes: Number(row.schema_bytes) };
}
async function apply(client: pg.PoolClient, position: RecordPosition, record: unknown) {
  await client.query('BEGIN');
  try {
    const result = await processRecord(client, position, JSON.stringify(record));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function runScenario(documents: Document[], factor: 1 | 3, connectionString: string) {
  const schema = schemaName();
  const admin = new pg.Client({ connectionString });
  const pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schema}`, statement_timeout: 60000 });
  let stopReading = false;
  let sampling: ReturnType<typeof setInterval> | undefined;
  let readers: Promise<void>[] = [];
  const readErrors: string[] = [];
  const readTimes: number[] = [];
  const snapshots: Record<string, number>[] = [];
  const maintenance: Record<string, unknown>[] = [];
  const initialMemory = process.memoryUsage();
  let sampledPeakRssBytes = initialMemory.rss;
  let sampledPeakHeapBytes = initialMemory.heapUsed;
  let offset = 0n;
  let revision = 0;
  let duplicateChecks = 0;
  let previous = new Map<string, string>();
  const validCounts = new Set(documents.map(document => normalizePredictions(document).length * factor));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quoteSchema(schema)}`); created = true;
    const writer = await pool.connect();
    try {
      assert.equal((await writer.query('SELECT current_schema() schema')).rows[0].schema, schema);
      await writer.query(await readFile(resolve(root, 'src/server/schema.sql'), 'utf8'));
      const before = await bytes(admin, schema);
      sampling = setInterval(() => {
        const memory = process.memoryUsage();
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, memory.rss);
        sampledPeakHeapBytes = Math.max(sampledPeakHeapBytes, memory.heapUsed);
      }, 20);
      const readLoop = async () => {
        const reader = await pool.connect();
        try {
          while (!stopReading) {
            const start = performance.now();
            const state = await loadTransit(reader);
            readTimes.push(performance.now() - start);
            assert(validCounts.has(state.predictions.length), 'concurrent read exposed a partial projection');
            assert.equal(new Set(state.predictions.map(row => row.id)).size, state.predictions.length);
            await delay(10);
          }
        } catch (error) { readErrors.push((error as Error).message); }
        finally { reader.release(); }
      };
      for (let round = 0; round < 3; round++) {
        for (const [capture, original] of documents.entries()) {
          revision++;
          const document = factor === 1 ? original : amplify(original, factor, 60 + revision * 5);
          const normalized = normalizePredictions(document);
          const next = new Map(normalized.map(row => [row.id, JSON.stringify(row)]));
          let changed = 0, added = 0, removed = 0;
          for (const [id, value] of next) {
            if (!previous.has(id)) added++;
            else if (previous.get(id) !== value) changed++;
          }
          for (const id of previous.keys()) if (!next.has(id)) removed++;
          const compressStart = performance.now();
          const records = makeSnapshot(document, { source: 'predictions', generation: 1, revision, observedAt: new Date().toISOString(), lastModified: null });
          const compressionMs = performance.now() - compressStart;
          const applyStart = performance.now();
          let manifestApplyMs = 0;
          let activated = 0;
          let lastPosition!: RecordPosition;
          for (const record of records) {
            const recordStart = performance.now();
            lastPosition = { topic, partition: 0, offset: String(offset++), capturedAt: new Date().toISOString() };
            const result = await apply(writer, lastPosition, record);
            if (result.activated) activated++;
            assert.equal(result.duplicate, false);
            if (record.kind === 'manifest') manifestApplyMs = performance.now() - recordStart;
          }
          const applyMs = performance.now() - applyStart;
          assert.equal(activated, 1, 'each complete snapshot must activate once');
          const count = (await writer.query('SELECT count(*)::int count, count(DISTINCT id)::int unique_count FROM current_predictions')).rows[0];
          assert.equal(count.count, normalized.length);
          assert.equal(count.unique_count, normalized.length);
          const catalogBefore = (await writer.query('SELECT count(*)::int count FROM snapshot_catalog')).rows[0].count;
          const duplicate = await apply(writer, lastPosition, records.at(-1));
          assert.equal(duplicate.duplicate, true);
          assert.equal(duplicate.activated, false);
          assert.equal((await writer.query('SELECT count(*)::int count FROM snapshot_catalog')).rows[0].count, catalogBefore);
          duplicateChecks++;
          snapshots.push({ round: round + 1, capture, revision, resources: document.data.length, projectedResources: normalized.length,
            rawBytes: records[0].rawBytes, compressedBytes: records[0].compressedBytes, chunks: records.length - 1,
            added, changed, removed, compressionMs: Number(compressionMs.toFixed(3)), applyMs: Number(applyMs.toFixed(3)), manifestApplyMs: Number(manifestApplyMs.toFixed(3)) });
          previous = next;
          if (!readers.length) readers = [readLoop(), readLoop()];
        }
        if (round < 2) {
          const start = performance.now();
          const maintenanceClient = await pool.connect();
          try {
            await maintenanceClient.query('CHECKPOINT');
            await maintenanceClient.query('VACUUM (ANALYZE) current_predictions');
            maintenance.push({ afterRound: round + 1, checkpoint: 'completed', scopedVacuumAnalyze: 'completed', elapsedMs: Number((performance.now() - start).toFixed(3)) });
          } finally { maintenanceClient.release(); }
        }
      }
      stopReading = true;
      await Promise.all(readers);
      assert.deepEqual(readErrors, []);
      assert(readTimes.length > 0, 'concurrent read measurements required');
      const after = await bytes(admin, schema);
      const walBytes = Number((await admin.query('SELECT pg_wal_lsn_diff($1,$2)::text bytes', [after.lsn, before.lsn])).rows[0].bytes);
      const tableStats = (await writer.query(`SELECT n_live_tup,n_dead_tup,vacuum_count,autovacuum_count,analyze_count,autoanalyze_count
        FROM pg_stat_user_tables WHERE schemaname=$1 AND relname='current_predictions'`, [schema])).rows[0];
      const updates = snapshots.slice(1);
      return { name: factor === 1 ? 'captured-citywide-replay' : 'synthetic-3x-citywide', synthetic: factor !== 1,
        startedAt, durationMs: Number((performance.now() - started).toFixed(3)), rounds: 3, baselineCount: 1, updateCount: updates.length,
        concurrentReaders: 2, interReadDelayMs: 10, baselineHadConcurrentReaders: false,
        updateApplyMs: distribution(updates.map(row => row.applyMs)), updateManifestApplyMs: distribution(updates.map(row => row.manifestApplyMs)),
        fullStateReadMs: distribution(readTimes), compressionMs: distribution(snapshots.map(row => row.compressionMs)),
        baselineApplyMs: snapshots[0].applyMs, snapshots, duplicateRedeliveryAssertions: duplicateChecks,
        concurrentReadErrors: readErrors, maintenance, tableStats,
        storage: { before, after, schemaGrowthBytes: after.schemaBytes - before.schemaBytes, sharedDatabaseGrowthBytes: after.databaseBytes - before.databaseBytes, sharedClusterWalBytes: walBytes },
        memory: { initial: initialMemory, final: process.memoryUsage(), sampledPeakRssBytes, sampledPeakHeapBytes,
          processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024 },
        isolatedSchemaDroppedOnExit: true };
    } finally { writer.release(); }
  } finally {
    stopReading = true;
    await Promise.all(readers);
    if (sampling) clearInterval(sampling);
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${quoteSchema(schema)} CASCADE`);
    await admin.end();
  }
}

async function main() {
  selfCheck();
  if (process.argv.includes('--self-check')) { process.stdout.write('Synthetic identity/time and percentile self-checks passed.\n'); return; }
  const index = process.argv.indexOf('--input');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: DATABASE_URL=... node --import tsx scripts/benchmark.ts --input <capture-directory>');
  const input = resolve(process.argv[index + 1]);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required; the script creates and removes only its own generated schemas');
  const documents: Document[] = [];
  const captures: Record<string, unknown>[] = [];
  for (let n = 0; n < 3; n++) {
    const filename = `predictions-${n}.json`;
    const path = resolve(input, filename);
    const metadata = await stat(path);
    assert(metadata.size <= MAX_RAW_BYTES, 'input file exceeds raw byte bound');
    const raw = await readFile(path);
    const document = JSON.parse(raw.toString('utf8')) as Document;
    const normalized = normalizePredictions(document);
    documents.push(document);
    captures.push({ filename, sha256: checksum(raw), fileBytes: raw.length, resources: document.data.length,
      revenueResources: normalized.length, fileModifiedAt: metadata.mtime.toISOString() });
  }
  const files = ['src/server/snapshots.ts', 'src/server/projection.ts', 'src/server/normalize.ts', 'src/server/schema.sql', 'src/shared/contracts.ts', 'scripts/benchmark.ts'];
  const sourceDigests = Object.fromEntries(await Promise.all(files.map(async path => [path, checksum(await readFile(resolve(root, path)))])));
  const inspector = new pg.Client({ connectionString });
  await inspector.connect();
  let database;
  try {
    database = (await inspector.query(`SELECT version(),current_setting('shared_buffers') shared_buffers,current_setting('work_mem') work_mem,
      current_setting('checkpoint_timeout') checkpoint_timeout,current_setting('autovacuum') autovacuum`)).rows[0];
  } finally { await inspector.end(); }
  const originalLog = console.log;
  console.log = (...args: unknown[]) => process.stderr.write(`${args.join(' ')}\n`);
  try {
    const results = [await runScenario(documents, 1, connectionString), await runScenario(documents, 3, connectionString)];
    process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), kind: 'short-direct-postgresql-projection-smoke',
      source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), fileSha256: sourceDigests },
      environment: { node: process.version, platform: platform(), arch: arch(), hostLogicalCpus: cpus().length, hostMemoryBytes: totalmem(), database }, captures,
      methodology: [
        'Three complete captured MBTA prediction snapshots are replayed three times without real-time pacing; this is a short burst smoke, not a live sustained load.',
        'Synthetic workload duplicates each resource/trip identity threefold and shifts non-null ETAs each iteration; route/stop identities remain shared.',
        'makeSnapshot compression is timed separately; apply times include sequential per-record BEGIN/processRecord/COMMIT through the completion manifest.',
        'Two concurrent readers call the full loadTransit projection with a 10ms pause; baseline loads have no readers. Read samples include checkpoint/vacuum periods.',
        'Projection tables exist only in generated schemas with no public search_path fallback; checkpoint and WAL are shared PostgreSQL-cluster operations.',
        'CHECKPOINT and scoped VACUUM ANALYZE run from another connection between rounds. Autovacuum is configured but its activity is reported, not assumed.',
        'WAL and whole-database growth can include unrelated processes. Schema relation growth is scoped; process memory includes capture data, synthetic builders, readers and earlier scenarios.',
        'Percentiles use nearest rank. Eight update samples per workload are too few for stable tail-latency or peak-capacity claims.',
        'No Kafka transport, consumer lag, HTTP API latency, journey evaluation or browser fan-out is measured here. Observation envelope times are rebased to benchmark execution.'
      ], results }, null, 2)}\n`);
  } finally { console.log = originalLog; }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
