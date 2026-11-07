import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server/api.js';
import { migrate } from '../../src/server/migrate.js';
import { pool } from '../../src/server/db.js';
let server: ReturnType<typeof createApp>, base: string;
before(async () => {
  await migrate();
  server = createApp({ secret: 'integration-secret-with-more-than-thirty-two-chars', origin: 'http://localhost:3000' });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); });
test('HTTP journey commands require the signed owner session and same origin', async () => {
  const board = await fetch(`${base}/api/board`);
  assert.equal(board.status,200);
  const cookie = board.headers.get('set-cookie')!.split(';')[0];
  const settings = { incomingTripId: 'http-red', preferredOutgoingTripId: null, extraTransferSeconds: 0, boarded: false };
  const headers = { Cookie: cookie, Origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'Idempotency-Key':'http-command' };
  const saved = await fetch(`${base}/api/journey`, { method:'POST',headers,body:JSON.stringify(settings) });
  assert.equal(saved.status,200); const journey = await saved.json();
  assert.equal((await (await fetch(`${base}/api/journey`,{headers:{Cookie:cookie}})).json()).id,journey.id);
  assert.equal(await (await fetch(`${base}/api/journey`)).json(),null);
  assert.equal((await fetch(`${base}/api/journey`,{method:'POST',headers:{...headers,Origin:'https://elsewhere.example'},body:JSON.stringify(settings)})).status,403);
  assert.equal((await fetch(`${base}/api/journey`,{method:'POST',headers,body:'{'})).status,400);
  assert.equal((await fetch(`${base}/api/replay`)).status,200);
  await fetch(`${base}/api/journey`,{method:'DELETE',headers});
});
test('concurrent event streams enforce the per-session limit without losing registrations', async () => {
  const board=await fetch(`${base}/api/board`);
  const cookie=board.headers.get('set-cookie')!.split(';')[0];
  const controllers=Array.from({length:4},()=>new AbortController());
  try {
    const streams=await Promise.all(controllers.map(c=>fetch(`${base}/api/events`,{headers:{Cookie:cookie},signal:c.signal})));
    assert.equal(streams.filter(r=>r.status===200).length,3);
    assert.equal(streams.filter(r=>r.status===429).length,1);
  } finally { controllers.forEach(c=>c.abort()); }
});
