import pg from 'pg';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 30000 });
pool.on('error', error => console.error(JSON.stringify({ event: 'postgres_pool_error', error: error.message })));
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
