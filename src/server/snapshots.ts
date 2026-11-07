import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export class RecordValidationError extends Error {}

export const CHUNK_BYTES = 256 * 1024;
export const MAX_RAW_BYTES = 64 * 1024 * 1024;
export const MAX_CHUNKS = 128;
export const PG_INTEGER_MAX = 2147483647;
export type Source = 'predictions' | 'alerts';
export interface SnapshotMeta {
  source: Source; generation: number; revision: number; observedAt: string; lastModified: string | null;
}
interface Envelope extends SnapshotMeta {
  schemaVersion: 1; encoding: 'gzip'; snapshotId: string; messageId: string;
  chunkCount: number; compressedBytes: number; rawBytes: number; digest: string;
}
export interface ChunkRecord extends Envelope { kind: 'chunk'; index: number; data: string; }
export interface ManifestRecord extends Envelope { kind: 'manifest'; }
export interface CommandRecord {
  kind: 'journey-command'; messageId: string; journeyId: string; revision: number;
}
export type FeedRecord = ChunkRecord | ManifestRecord;
export type WireRecord = FeedRecord | CommandRecord;
export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function makeSnapshot(document: unknown, meta: SnapshotMeta): FeedRecord[] {
  const raw = Buffer.from(JSON.stringify(document));
  if (raw.length > MAX_RAW_BYTES) throw new RecordValidationError('snapshot raw size exceeds bound');
  const compressed = gzipSync(raw);
  const chunkCount = Math.ceil(compressed.length / CHUNK_BYTES);
  if (chunkCount > MAX_CHUNKS) throw new RecordValidationError('snapshot compressed size exceeds bound');
  const snapshotId = `${meta.source}:${meta.generation}:${meta.revision}`;
  const envelope = { ...meta, schemaVersion: 1 as const, encoding: 'gzip' as const, snapshotId,
    chunkCount, compressedBytes: compressed.length, rawBytes: raw.length, digest: digest(compressed) };
  const records: FeedRecord[] = [];
  for (let index = 0; index < chunkCount; index++) records.push({ ...envelope, kind: 'chunk', index,
    messageId: `${snapshotId}:${index}`, data: compressed.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') });
  records.push({ ...envelope, kind: 'manifest', messageId: `${snapshotId}:complete` });
  return records;
}
function integer(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new RecordValidationError(`invalid ${name}`);
}
function string(value: unknown, name: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new RecordValidationError(`invalid ${name}`);
}
function timestamp(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new RecordValidationError(`invalid ${name}`);
}
export function parseRecord(text: string): WireRecord {
  if (Buffer.byteLength(text) > 400 * 1024) throw new RecordValidationError('record size exceeds bound');
  let r;
  try { r = JSON.parse(text); } catch { throw new RecordValidationError('invalid record JSON'); }
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RecordValidationError('invalid envelope');
  string(r.messageId, 'messageId');
  integer(r.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
  if (r.kind === 'journey-command') {
    string(r.journeyId, 'journeyId', 128);
    return r as CommandRecord;
  }
  if (!['chunk', 'manifest'].includes(r.kind) || !['predictions', 'alerts'].includes(r.source)) throw new RecordValidationError('invalid kind/source');
  if (r.schemaVersion !== 1 || r.encoding !== 'gzip') throw new RecordValidationError('unsupported snapshot schema/encoding');
  integer(r.generation, 'generation', 1, PG_INTEGER_MAX);
  integer(r.chunkCount, 'chunkCount', 1, MAX_CHUNKS);
  integer(r.rawBytes, 'rawBytes', 1, MAX_RAW_BYTES);
  integer(r.compressedBytes, 'compressedBytes', 1, CHUNK_BYTES * MAX_CHUNKS);
  if (r.chunkCount !== Math.ceil(r.compressedBytes / CHUNK_BYTES)) throw new RecordValidationError('inconsistent chunkCount');
  timestamp(r.observedAt, 'observedAt');
  if (r.lastModified !== null) timestamp(r.lastModified, 'lastModified');
  if (r.snapshotId !== `${r.source}:${r.generation}:${r.revision}`) throw new RecordValidationError('invalid snapshotId');
  if (typeof r.digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.digest)) throw new RecordValidationError('invalid digest');
  if (r.kind === 'chunk') {
    integer(r.index, 'index', 0, r.chunkCount - 1);
    string(r.data, 'chunk data', Math.ceil(CHUNK_BYTES / 3) * 4);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data)) throw new RecordValidationError('invalid base64');
    const size = Buffer.from(r.data, 'base64').length;
    const expected = r.index === r.chunkCount - 1 ? r.compressedBytes - r.index * CHUNK_BYTES : CHUNK_BYTES;
    if (size !== expected) throw new RecordValidationError('invalid chunk size');
  }
  const suffix = r.kind === 'chunk' ? r.index : 'complete';
  if (r.messageId !== `${r.snapshotId}:${suffix}`) throw new RecordValidationError('invalid messageId');
  return r as FeedRecord;
}
export function restoreSnapshot(manifest: ManifestRecord, chunks: ChunkRecord[]): unknown {
  if (manifest.kind !== 'manifest' || chunks.length !== manifest.chunkCount) throw new RecordValidationError('incomplete snapshot');
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  for (const [i, c] of sorted.entries()) {
    for (const key of ['source', 'generation', 'revision', 'observedAt', 'lastModified', 'snapshotId', 'digest', 'rawBytes', 'compressedBytes', 'chunkCount'] as const) {
      if (c[key] !== manifest[key]) throw new RecordValidationError('snapshot metadata mismatch');
    }
    if (c.kind !== 'chunk' || c.index !== i) throw new RecordValidationError('incomplete chunk indices');
  }
  const bytes = Buffer.concat(sorted.map(c => Buffer.from(c.data, 'base64')));
  if (bytes.length !== manifest.compressedBytes || digest(bytes) !== manifest.digest) throw new RecordValidationError('snapshot digest/size mismatch');
  try {
    const raw = gunzipSync(bytes, { maxOutputLength: MAX_RAW_BYTES });
    if (raw.length !== manifest.rawBytes) throw new RecordValidationError('snapshot raw size mismatch');
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new RecordValidationError(error instanceof Error ? error.message : 'invalid compressed snapshot');
  }
}
