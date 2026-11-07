import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCollection, SourceError } from '../src/server/source.js';

test('all pages are included before a collection is returned', async () => {
  const urls: string[] = [];
  const result = await fetchCollection('/predictions', { 'filter[route]': 'Red' }, async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(urls.length === 1 ? { data: [{ id: '1' }], links: { next: 'https://api-v3.mbta.com/predictions?page[offset]=1' } } : { data: [{ id: '2' }] }), { headers: { 'Last-Modified': 'Fri, 06 Nov 2026 10:00:00 GMT' } });
  });
  assert.deepEqual(result.document.data, [{ id: '1' }, { id: '2' }]);
  assert.equal(result.lastModified, '2026-11-06T10:00:00.000Z');
  assert.equal(urls.length, 2);
});
test('pagination cannot redirect ingestion to an arbitrary URL', async () => {
  await assert.rejects(fetchCollection('/alerts', {}, async () => new Response(JSON.stringify({ data: [], links: { next: 'https://evil.example/private' } }))), /pagination/);
});
test('rate limits retain Retry-After instead of retrying immediately', async () => {
  await assert.rejects(fetchCollection('/alerts', {}, async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } })), (error: unknown) => error instanceof SourceError && error.retryAfterMs >= 60000);
});
test('oversized and malformed source responses never produce complete snapshots', async () => {
  await assert.rejects(fetchCollection('/alerts', {}, async () => new Response('{}', { headers: { 'Content-Length': '999999999' } })), /size/);
  await assert.rejects(fetchCollection('/alerts', {}, async () => new Response('{"data":{}}')), /data/);
});
