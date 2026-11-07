import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { makeSnapshot, parseRecord, restoreSnapshot, CHUNK_BYTES } from '../src/server/snapshots.js';

const meta = { source: 'predictions' as const, generation: 1, revision: 1, observedAt: '2026-11-06T10:00:00Z', lastModified: null };
test('snapshot preserves a large source through bounded chunks and manifest', () => {
  const data = { data: [{ id: 'large', payload: randomBytes(800000).toString('base64') }] };
  const records = makeSnapshot(data, meta);
  assert.ok(records.length >= 4);
  const manifest = records.at(-1)!;
  assert.equal(manifest.kind, 'manifest');
  const chunks = records.slice(0, -1);
  for (const chunk of chunks) {
    assert.equal(chunk.kind, 'chunk');
    if (chunk.kind === 'chunk') assert.ok(Buffer.from(chunk.data, 'base64').length <= CHUNK_BYTES);
    assert.deepEqual(parseRecord(JSON.stringify(chunk)), chunk);
  }
  assert.deepEqual(restoreSnapshot(manifest as never, chunks as never), data);
});
test('missing or corrupted chunks cannot become a complete snapshot', () => {
  const records = makeSnapshot({ data: [{ id: 'p1' }] }, meta);
  const manifest = records.at(-1)!;
  assert.throws(() => restoreSnapshot(manifest as never, []), /incomplete/i);
  const chunk = { ...records[0], data: Buffer.from('wrong').toString('base64') };
  assert.throws(() => restoreSnapshot(manifest as never, [chunk] as never), /digest|size/i);
});
test('wire parser rejects oversized bounds and incompatible chunk metadata', () => {
  const records = makeSnapshot({ data: [] }, meta);
  assert.throws(() => parseRecord(JSON.stringify({ ...records[0], chunkCount: 999999 })), /chunkCount/);
  assert.throws(() => parseRecord(JSON.stringify({ ...records[0], observedAt: 'bad' })), /observedAt/);
  assert.throws(() => restoreSnapshot(records.at(-1) as never, [{ ...records[0], generation: 2 }] as never), /metadata/i);
});
test('separate observations have stable unique semantic message identities', () => {
  const a = makeSnapshot({ data: [] }, meta);
  const b = makeSnapshot({ data: [] }, meta);
  const c = makeSnapshot({ data: [] }, { ...meta, revision: 2 });
  assert.equal(a[0].messageId, b[0].messageId);
  assert.notEqual(a[0].messageId, c[0].messageId);
});

test('invalid gzip with a matching digest is a quarantineable validation error', async () => {
  const { digest, RecordValidationError } = await import('../src/server/snapshots.js');
  const records = makeSnapshot({ data: [] }, meta);
  const bytes = Buffer.from('not gzip');
  const replacement = { digest: digest(bytes), compressedBytes: bytes.length };
  const manifest = { ...records.at(-1), ...replacement };
  const chunk = { ...records[0], ...replacement, data: bytes.toString('base64') };
  assert.throws(() => restoreSnapshot(manifest as never, [chunk] as never), RecordValidationError);
});

test('generation values outside PostgreSQL integer range fail at the wire boundary', async () => {
  const { RecordValidationError } = await import('../src/server/snapshots.js');
  const tooLarge = makeSnapshot({ data: [] }, { ...meta, generation: 2147483648 });
  assert.throws(() => parseRecord(JSON.stringify(tooLarge[0])), RecordValidationError);
  const largest = makeSnapshot({ data: [] }, { ...meta, generation: 2147483647 });
  assert.equal((parseRecord(JSON.stringify(largest[0])) as typeof largest[0]).generation, 2147483647);
});

test('long worker operations keep heartbeating and stop pulses when work completes', async () => {
  const { withHeartbeats } = await import('../src/server/worker.js');
  let pulses = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const timeout = setTimeout(() => finish(), 200);
  try {
    const result = await withHeartbeats(async () => { await done; return 'committed'; }, async () => {
      pulses++; if (pulses >= 3) finish();
    }, 5);
    assert.equal(result, 'committed');
    assert.ok(pulses >= 3, 'heartbeats must continue while the operation is pending');
    const settled = pulses;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pulses, settled, 'heartbeat timer must stop after work');
  } finally { clearTimeout(timeout); }
});

test('heartbeat failure waits for outstanding work then propagates without committing offsets', async () => {
  const { withHeartbeats } = await import('../src/server/worker.js');
  const heartbeatError = new Error('consumer membership lost');
  let pulses = 0, workFinished = false, offsetCommitted = false;
  await assert.rejects(async () => {
    await withHeartbeats(async () => {
      await new Promise(resolve => setTimeout(resolve, 25)); workFinished = true;
    }, async () => { pulses++; if (pulses === 2) throw heartbeatError; }, 5);
    offsetCommitted = true;
  }, error => error === heartbeatError);
  assert.equal(workFinished, true);
  assert.equal(offsetCommitted, false);
  assert.equal(pulses, 2);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(pulses, 2);
});

test('worker operation failure is preserved and heartbeat interval is cleaned up', async () => {
  const { withHeartbeats } = await import('../src/server/worker.js');
  const workError = new Error('database operation failed');
  let pulses = 0;
  await assert.rejects(withHeartbeats(async () => {
    await new Promise(resolve => setTimeout(resolve, 15)); throw workError;
  }, async () => { pulses++; }, 5), error => error === workError);
  const settled = pulses;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pulses, settled);
});
