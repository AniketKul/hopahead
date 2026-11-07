import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { eventSink } from '../src/server/sse.js';
test('SSE retains healthy streams under backpressure and coalesces superseded snapshots', async () => {
  const chunks:string[]=[]; let release:(()=>void)|undefined;
  const stream=new Writable({highWaterMark:1,write(chunk,_encoding,done){chunks.push(chunk.toString());release=done;}});
  const send=eventSink(stream);
  send('first');send('superseded');send('latest');
  assert.equal(stream.writableEnded,false);
  assert.deepEqual(chunks,['first']);
  release!(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(chunks,['first','latest']);
  release!();stream.end();
});
test('SSE rejects payloads beyond its bounded buffering budget', () => {
  const stream=new Writable({write(_c,_e,done){done();}});
  eventSink(stream)('x'.repeat(1024*1024+1));
  assert.equal(stream.writableEnded,true);
});
