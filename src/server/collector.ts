import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { createProducer, ensureTopics, publishSnapshot } from './broker.js';
import { fetchCollection, routeIds, SourceError, type Fetcher } from './source.js';
import type { Source } from './snapshots.js';

export async function acquireOwnership(client: pg.PoolClient) {
  if (!(await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema() || 'hopahead.collector',0)) owned")).rows[0].owned) throw new Error('another collector owns the feed');
  let alive = true;
  const onError = () => { alive = false; };
  client.on('error', onError);
  const generations = {} as Record<Source, number>;
  await client.query('BEGIN');
  try {
    for (const source of ['predictions', 'alerts'] as const) {
      const result = await client.query(`INSERT INTO collector_generations(source,generation) VALUES($1,1)
        ON CONFLICT(source) DO UPDATE SET generation=collector_generations.generation+1,acquired_at=now() RETURNING generation`, [source]);
      generations[source] = result.rows[0].generation;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); client.off('error', onError);
    await client.query("SELECT pg_advisory_unlock(hashtextextended(current_schema() || 'hopahead.collector',0))"); throw error;
  }
  return { generations, async assertOwned() {
    if (!alive) throw new Error('collector ownership connection lost');
    const result = await client.query('SELECT source,generation FROM collector_generations');
    if (!alive || result.rows.some(r => generations[r.source as Source] !== r.generation)) throw new Error('collector generation superseded');
  }, async release() { alive = false; client.off('error', onError); await client.query("SELECT pg_advisory_unlock(hashtextextended(current_schema() || 'hopahead.collector',0))"); } };
}
export async function runCollector() {
  await migrate(); await ensureTopics();
  const client = await pool.connect();
  let ownership: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
  let producer: Awaited<ReturnType<typeof createProducer>> | undefined;
  let running = true, nextRequest = 0;
  const stop = () => { running = false; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const limitedFetch: Fetcher = async (url, init) => {
    await sleep(Math.max(0, nextRequest - Date.now()));
    if (!running) throw new Error('collector stopping');
    nextRequest = Date.now() + 3100;
    return fetch(url, init);
  };
  try {
    ownership = await acquireOwnership(client); producer = await createProducer();
    let routes: string[] = [], routesAt = 0;
    const due: Record<Source, number> = { predictions: 0, alerts: 0 };
    const revisions: Record<Source, number> = { predictions: 0, alerts: 0 };
    while (running) {
      await ownership.assertOwned();
      try {
        if (!routes.length || Date.now() - routesAt > 6 * 3600000) {
          routes = await routeIds(limitedFetch);
          if (!routes.length) throw new Error('MBTA route catalog is empty');
          routesAt = Date.now();
        }
        for (const source of ['predictions', 'alerts'] as const) {
          if (!running || Date.now() < due[source]) continue;
          due[source] = Date.now() + (source === 'predictions' ? 15000 : 60000);
          const collection = source === 'predictions'
            ? await fetchCollection('/predictions', { 'filter[route]': routes.join(','), 'filter[revenue]': 'REVENUE,NON_REVENUE' }, limitedFetch)
            : await fetchCollection('/alerts', { 'filter[activity]': 'ALL' }, limitedFetch);
          const captured = await publishSnapshot(producer, collection.document, { source, generation: ownership.generations[source],
            revision: ++revisions[source], observedAt: collection.observedAt, lastModified: collection.lastModified }, ownership.assertOwned);
          console.log(JSON.stringify({ event: 'snapshot_captured', source, resources: collection.document.data.length, ...captured }));
        }
        await sleep(500);
      } catch (error) {
        console.error(JSON.stringify({ event: 'collector_retry', error: error instanceof Error ? error.message : 'unknown source error' }));
        await ownership.assertOwned();
        await sleep(error instanceof SourceError ? error.retryAfterMs : 15000);
      }
    }
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await producer?.disconnect();
    await ownership?.release().catch(() => {});
    client.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCollector(); } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await pool.end(); }
}
