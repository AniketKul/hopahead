import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/server/db.js';
import { migrate } from '../../src/server/migrate.js';
import { saveJourney, getJourney, deleteJourney, refreshJourneys } from '../../src/server/journeys.js';
before(async () => { await migrate(); });
after(async () => { await pool.end(); });
const settings = { incomingTripId: 'test-red', preferredOutgoingTripId: null, extraTransferSeconds: 60, boarded: false };
async function owner() {
  const id = randomUUID();
  await pool.query("INSERT INTO sessions(id,expires_at) VALUES($1,now()+interval '1 day')", [id]);
  return id;
}
test('command idempotency is owner scoped and conflicts do not mutate settings', async () => {
  const a = await owner(), b = await owner();
  try {
    const first = await saveJourney(a, settings, 'same-key');
    const retry = await saveJourney(a, settings, 'same-key');
    assert.equal(first.id, retry.id); assert.equal(first.revision, retry.revision);
    await assert.rejects(saveJourney(a, { ...settings, extraTransferSeconds: 120 }, 'same-key'), /different/);
    const other = await saveJourney(b, settings, 'same-key');
    assert.notEqual(first.id, other.id);
    assert.equal((await getJourney(a))?.id, first.id);
    assert.equal((await pool.query('SELECT count(*) FROM outbox WHERE journey_id=$1', [first.id])).rows[0].count, '1');
    await refreshJourneys();
    const view = await getJourney(a);
    assert.ok(view?.advice); assert.ok(view.history[0].input);
    const revision = view.revision;
    await refreshJourneys();
    assert.equal((await getJourney(a))?.revision, revision);
    await deleteJourney(a);
    assert.equal(await getJourney(a), null);
    assert.equal((await getJourney(b))?.id, other.id);
  } finally { await pool.query('DELETE FROM sessions WHERE id=ANY($1::uuid[])', [[a,b]]); }
});
test('overlapping refresh passes cannot evaluate across an active pass boundary', async () => {
  const a = await owner();
  const lock = await pool.connect();
  let completed = false;
  try {
    await saveJourney(a,settings,'concurrent');
    await lock.query('SELECT pg_advisory_lock(72103002)');
    const refresh = refreshJourneys().then(() => { completed=true; });
    await new Promise(resolve => setTimeout(resolve,150));
    assert.equal(completed,false,'new pass must wait before capturing source data');
    assert.equal((await getJourney(a))?.advice,null);
    await lock.query('SELECT pg_advisory_unlock(72103002)');
    await refresh;
    assert.ok((await getJourney(a))?.advice);
    const revision=(await getJourney(a))!.revision;
    await Promise.all([refreshJourneys(),refreshJourneys()]);
    assert.equal((await getJourney(a))!.revision,revision);
  } finally {
    await lock.query('SELECT pg_advisory_unlock(72103002)');lock.release();
    await pool.query('DELETE FROM sessions WHERE id=$1',[a]);
  }
});
