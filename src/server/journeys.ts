import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, transaction } from './db.js';
import { loadTransit } from './projection.js';
import { evaluate, captureEvidence } from '../domain/advice.js';
import { transfers } from '../domain/transfers.js';
import { HttpError } from './security.js';
import type { Advice, EvaluationInput, JourneySettings, JourneyView } from '../shared/contracts.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const supportedRoutes = ['Red','Green-B','Green-C','Green-D','Green-E'];
function material(advice: Advice, settings: JourneySettings) {
  const { evaluatedAt: _time, source: _source, ...facts } = advice;
  return hash({ settings, facts });
}
async function view(db: Pick<PoolClient, 'query'>, row: Record<string, any>): Promise<JourneyView> {
  const history = await db.query('SELECT id,created_at,advice,input FROM decisions WHERE journey_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30', [row.id]);
  return { id: row.id, revision: row.revision, settings: row.settings, advice: row.advice,
    updatedAt: new Date(row.updated_at).toISOString(), history: history.rows.map(r => ({ id: r.id, createdAt: new Date(r.created_at).toISOString(), advice: r.advice, input: r.input })) };
}
export async function getJourney(owner: string): Promise<JourneyView | null> {
  const result = await pool.query('SELECT j.* FROM journeys j JOIN sessions s ON s.id=j.owner WHERE j.owner=$1 AND s.expires_at>now()', [owner]);
  return result.rows[0] ? view(pool, result.rows[0]) : null;
}
export async function saveJourney(owner: string, settings: JourneySettings, key: string): Promise<JourneyView> {
  return transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    const session = await db.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>now()', [owner]);
    if (!session.rowCount) throw new HttpError(401, 'Your session expired. Refresh the page.');
    const existing = await db.query('SELECT request_hash,response FROM journey_commands WHERE owner=$1 AND key=$2', [owner,key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash(settings)) throw new HttpError(409, 'This request key was used with different settings.');
      return existing.rows[0].response;
    }
    const recent = await db.query("SELECT count(*) FROM journey_commands WHERE owner=$1 AND created_at>now()-interval '1 minute'", [owner]);
    if (Number(recent.rows[0].count) >= 20) throw new HttpError(429, 'Please wait before changing your journey again.');
    const result = await db.query(`INSERT INTO journeys(id,owner,settings) VALUES($1,$2,$3)
      ON CONFLICT(owner) DO UPDATE SET settings=excluded.settings,settings_revision=journeys.settings_revision+1,
      revision=journeys.revision+1,advice=NULL,evidence_hash=NULL,updated_at=now() RETURNING *`, [randomUUID(),owner,settings]);
    const row = result.rows[0];
    await db.query('INSERT INTO outbox(id,journey_id,revision) VALUES($1,$2,$3)', [randomUUID(),row.id,row.settings_revision]);
    const response = await view(db,row);
    await db.query('INSERT INTO journey_commands(owner,key,request_hash,response) VALUES($1,$2,$3,$4)', [owner,key,hash(settings),response]);
    await db.query("SELECT pg_notify('journeys',$1)", [owner]);
    return response;
  });
}
export async function deleteJourney(owner: string): Promise<void> {
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
    await db.query('DELETE FROM journeys WHERE owner=$1', [owner]);
    await db.query('DELETE FROM journey_commands WHERE owner=$1', [owner]);
    await db.query("SELECT pg_notify('journeys',$1)", [owner]);
  });
}
export async function refreshJourneys(): Promise<void> {
  const guard=await pool.connect();
  try {
    // Lock before reading transit so overlapping workers cannot publish an older pass last.
    await guard.query('SELECT pg_advisory_lock(72103002)');
    await refreshPass();
  } finally {
    try { await guard.query('SELECT pg_advisory_unlock(72103002)'); }
    finally { guard.release(); }
  }
}
async function refreshPass(): Promise<void> {
  const owners = await pool.query('SELECT owner FROM journeys');
  if (!owners.rowCount) return;
  const transit = await loadTransit(pool,supportedRoutes);
  for (const { owner } of owners.rows) {
    await transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner]);
      const result = await db.query('SELECT j.* FROM journeys j JOIN sessions s ON s.id=j.owner WHERE owner=$1 AND s.expires_at>now() FOR UPDATE OF j', [owner]);
      const row = result.rows[0]; if (!row) return;
      const input: EvaluationInput = { transit, settings: row.settings, transfers, evaluatedAt: new Date().toISOString() };
      const advice = evaluate(input), digest = material(advice, row.settings);
      const changed = digest !== row.evidence_hash;
      const healthChanged = JSON.stringify(advice.source) !== JSON.stringify(row.advice?.source);
      if (!changed && !healthChanged) return;
      if (changed) {
        await db.query('INSERT INTO decisions(id,journey_id,advice,input) VALUES($1,$2,$3,$4)', [randomUUID(),row.id,advice,captureEvidence(input,advice)]);
        await db.query('DELETE FROM decisions WHERE journey_id=$1 AND id NOT IN (SELECT id FROM decisions WHERE journey_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100)', [row.id]);
      }
      await db.query('UPDATE journeys SET advice=$2,evidence_hash=$3,revision=revision+1,updated_at=now() WHERE id=$1', [row.id,advice,digest]);
      await db.query("SELECT pg_notify('journeys',$1)", [owner]);
    });
  }
}
