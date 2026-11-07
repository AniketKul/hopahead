import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { acquireOwnership } from '../../src/server/collector.js';

test('collector ownership excludes a second collector and fences a lost session', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const a = await pool.connect(), b = await pool.connect();
  const schema = `ownership_test_${process.pid}`;
  let lease: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
  try {
    await a.query(`CREATE SCHEMA ${schema}`);
    for (const c of [a, b]) await c.query(`SET search_path TO ${schema}`);
    await a.query('CREATE TABLE collector_generations(source text PRIMARY KEY,generation integer NOT NULL,acquired_at timestamptz DEFAULT now())');
    lease = await acquireOwnership(a);
    assert.equal(lease.generations.predictions, 1);
    await assert.rejects(acquireOwnership(b), /another collector/);
    await lease.assertOwned();
    a.emit('error', new Error('simulated connection loss'));
    await assert.rejects(lease.assertOwned(), /connection lost/);
    await lease.release(); lease = undefined;
    const next = await acquireOwnership(b);
    assert.equal(next.generations.predictions, 2);
    await next.release();
  } finally {
    if (lease) await lease.release();
    await a.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    a.release(); b.release(); await pool.end();
  }
});
