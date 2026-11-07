import { pathToFileURL } from 'node:url';
import { pool, transaction } from './db.js';
import { createProducer, ensureTopics, topics } from './broker.js';
import type { Producer } from 'kafkajs';

export async function relayOnce(producer: Producer): Promise<number> {
  return transaction(async db => {
    const result = await db.query('SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED');
    for (const row of result.rows) {
      await producer.send({ topic: topics.commands, acks: -1, messages: [{ partition: 0, key: row.journey_id,
        value: JSON.stringify({ kind: 'journey-command', messageId: row.id, journeyId: row.journey_id, revision: row.revision }) }] });
      await db.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
    }
    return result.rowCount ?? 0;
  });
}
async function main() {
  await ensureTopics(); const producer = await createProducer(); let running = true;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { running = false; });
  while (running) {
    try { const count = await relayOnce(producer); if (count) console.log(JSON.stringify({ event: 'outbox_published', count })); }
    catch { console.error(JSON.stringify({ event: 'outbox_retry' })); }
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  await producer.disconnect(); await pool.end();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Relay startup failed'); process.exitCode=1; });
