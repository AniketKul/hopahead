import { MAX_RAW_BYTES } from './snapshots.js';
import { MAX_RESOURCES } from './normalize.js';

const ORIGIN = 'https://api-v3.mbta.com';
export class SourceError extends Error {
  constructor(message: string, public retryAfterMs = 15000) { super(message); }
}
export interface Collection { document: { data: unknown[]; included?: unknown[] }; lastModified: string | null; observedAt: string; }
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export async function fetchCollection(path: '/routes' | '/predictions' | '/alerts', params: Record<string, string>, fetcher: Fetcher = fetch): Promise<Collection> {
  let url: URL | null = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const data: unknown[] = [], included: unknown[] = [];
  const visited = new Set<string>();
  let bytes = 0, lastModified: string | null = null;
  while (url) {
    if (visited.size >= 32 || visited.has(url.href) || url.origin !== ORIGIN || url.pathname !== path) throw new SourceError('unsafe or excessive pagination');
    visited.add(url.href);
    const headers: Record<string, string> = { Accept: 'application/vnd.api+json' };
    if (process.env.MBTA_API_KEY) headers['x-api-key'] = process.env.MBTA_API_KEY;
    const response = await fetcher(url.href, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const reset = response.headers.get('x-ratelimit-reset');
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : reset ? Number(reset) * 1000 - Date.now() : 15000;
      throw new SourceError(`MBTA ${path} returned HTTP ${response.status}`, Math.min(3600000, Math.max(15000, Number.isFinite(delay) ? delay : 15000)));
    }
    if (Number(response.headers.get('Content-Length')) > MAX_RAW_BYTES) throw new SourceError('source size exceeds bound');
    if (!response.body) throw new SourceError('source response has no body');
    const reader = response.body.getReader(), buffers: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RAW_BYTES) throw new SourceError('source size exceeds bound');
        buffers.push(part.value);
      }
    } finally { await reader.cancel(); }
    const document = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!document || !Array.isArray(document.data)) throw new SourceError('invalid source data');
    if (data.length + document.data.length > MAX_RESOURCES) throw new SourceError('source resource count exceeds bound');
    for (const row of document.data) data.push(row);
    if (document.included !== undefined) {
      if (!Array.isArray(document.included)) throw new SourceError('invalid included data');
      if (included.length + document.included.length > MAX_RESOURCES) throw new SourceError('included resource count exceeds bound');
      for (const row of document.included) included.push(row);
    }
    const modified = response.headers.get('Last-Modified');
    if (visited.size === 1 && modified && Number.isFinite(Date.parse(modified))) lastModified = new Date(modified).toISOString();
    const next = document.links?.next;
    if (next != null && typeof next !== 'string') throw new SourceError('invalid pagination link');
    url = next ? new URL(next, ORIGIN) : null;
  }
  return { document: included.length ? { data, included } : { data }, lastModified, observedAt: new Date().toISOString() };
}
export async function routeIds(fetcher?: Fetcher): Promise<string[]> {
  const { document } = await fetchCollection('/routes', { 'filter[listed_route]': 'false' }, fetcher);
  return document.data.map(r => {
    if (!r || typeof r !== 'object' || !('id' in r) || typeof r.id !== 'string' || !r.id.length || r.id.length > 128) throw new SourceError('invalid route id');
    return r.id;
  });
}
