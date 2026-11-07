import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pool, transaction } from './db.js';
export async function migrate() {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(708001)');
    for (const name of ['schema.sql', 'journeys.sql']) {
      try { await client.query(await readFile(new URL(name, import.meta.url), 'utf8')); }
      catch (error) {
        if (name !== 'journeys.sql' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrate(); console.log(JSON.stringify({ event: 'migration_complete' })); }
  finally { await pool.end(); }
}
