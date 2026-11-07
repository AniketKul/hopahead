import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, transaction } from './db.js';
import { loadTransit } from './projection.js';
import { getJourney, saveJourney, deleteJourney, supportedRoutes } from './journeys.js';
import { signSession, readSession, validateSettings, checkOrigin, idempotencyKey, HttpError } from './security.js';
import { listIncoming } from '../domain/advice.js';
import { transfers } from '../domain/transfers.js';
import { scenarios } from '../fixtures/scenarios.js';
import { eventSink } from './sse.js';

interface Options { secret: string; origin: string; }
const ttl = 7*24*60*60*1000;
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415,'Send JSON.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 4096) throw new HttpError(413,'Request too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400,'Invalid JSON.'); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(data));
}
export function createApp(options: Options) {
  if (options.secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const listeners = new Map<string, Set<ServerResponse>>();
  const sinks = new WeakMap<ServerResponse, (payload:string)=>void>();
  const revisions = new Map<string, string>();
  const attempts = new Map<string, { until: number; count: number }>();
  let polling = false;
  async function session(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const signed = readSession(req.headers.cookie, options.secret, Date.now());
    if (signed && (await pool.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>now()', [signed])).rowCount) return signed;
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    for (const [key,value] of attempts) if(value.until<=now) attempts.delete(key);
    const entry = attempts.get(ip) ?? { until:now+3600000,count:0 }; entry.count++; attempts.set(ip,entry);
    if(entry.count>60 || attempts.size>5000) throw new HttpError(429,'Too many new sessions. Please try later.');
    const id = randomUUID(), expires = now+ttl;
    await transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(72103001)');
      const count = await db.query('SELECT count(*) FROM sessions');
      if(Number(count.rows[0].count)>=5000) throw new HttpError(503,'The demo is at capacity. Please try later.');
      await db.query('INSERT INTO sessions(id,expires_at) VALUES($1,$2)',[id,new Date(expires)]);
    });
    res.setHeader('set-cookie',`hop_session=${signSession(id,expires,options.secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl/1000}${options.origin.startsWith('https:')?'; Secure':''}`);
    return id;
  }
  async function publish() {
    if(polling) return; polling=true;
    try {
      for(const [owner,clients] of listeners) {
        const journey = await getJourney(owner), revision = journey ? `${journey.id}:${journey.revision}` : 'none';
        if(revisions.get(owner)===revision) continue;
        revisions.set(owner,revision);
        const payload=`event: journey\ndata: ${JSON.stringify(journey)}\n\n`;
        for(const res of clients) {
          sinks.get(res)?.(payload);
        }
      }
    } catch { console.error(JSON.stringify({event:'sse_refresh_failed'})); }
    finally { polling=false; }
  }
  const timer = setInterval(() => { void publish(); },2000); timer.unref();
  const heartbeat = setInterval(() => {
    for(const clients of listeners.values()) for(const res of clients) if(!res.writableNeedDrain) sinks.get(res)?.(': heartbeat\n\n');
  },15000); heartbeat.unref();
  const cleanup = setInterval(() => {
    void pool.query("DELETE FROM sessions WHERE expires_at<now()").catch(()=>{});
    void pool.query("DELETE FROM journey_commands WHERE created_at<now()-interval '1 day'").catch(()=>{});
    void pool.query("DELETE FROM outbox WHERE published_at<now()-interval '1 day'").catch(()=>{});
    void pool.query("DELETE FROM decisions WHERE created_at<now()-interval '7 days'").catch(()=>{});
  },60000); cleanup.unref();
  const server=createServer(async (req,res) => {
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','same-origin');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url=new URL(req.url??'/',options.origin), method=req.method??'GET';
      if(url.pathname.startsWith('/api/')) {
        if(!['GET','POST','DELETE'].includes(method)) throw new HttpError(405,'Method not allowed.');
        if(method!=='GET') checkOrigin(req.headers.origin,options.origin);
        if(url.pathname==='/api/replay'&&method==='GET') return json(res,200,scenarios);
        if(url.pathname==='/api/health'&&method==='GET') {
          await pool.query('SELECT 1'); return json(res,200,{api:'ready',now:new Date().toISOString()});
        }
        const owner=await session(req,res);
        if(url.pathname==='/api/board'&&method==='GET') {
          const transit=await loadTransit(pool,supportedRoutes), now=new Date().toISOString();
          return json(res,200,{incoming:listIncoming(transit.predictions,now),source:transit.predictionHealth,serverTime:now,transfers,journey:await getJourney(owner)});
        }
        if(url.pathname==='/api/journey') {
          if(method==='GET') return json(res,200,await getJourney(owner));
          if(method==='POST') return json(res,200,await saveJourney(owner,validateSettings(await jsonBody(req)),idempotencyKey(req.headers['idempotency-key'])));
          await deleteJourney(owner); return json(res,200,null);
        }
        if(url.pathname==='/api/events'&&method==='GET') {
          const journey=await getJourney(owner);
          const clients=listeners.get(owner)??new Set();
          if(clients.size>=3 || [...listeners.values()].reduce((n,s)=>n+s.size,0)>=500) throw new HttpError(429,'Too many live connections.');
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
          const send=eventSink(res);sinks.set(res,send);
          send(`event: journey\ndata: ${JSON.stringify(journey)}\n\n`);
          clients.add(res); listeners.set(owner,clients);
          req.on('close',()=>{clients.delete(res);if(!clients.size&&listeners.get(owner)===clients){listeners.delete(owner);revisions.delete(owner);}});
          return;
        }
        throw new HttpError(404,'Not found.');
      }
      if(method!=='GET'&&method!=='HEAD') throw new HttpError(405,'Method not allowed.');
      const root=resolve('dist'), pathname=decodeURIComponent(url.pathname);
      const file=resolve(root,`.${pathname==='/'?'/index.html':pathname}`);
      if(!file.startsWith(root+sep)) throw new HttpError(404,'Not found.');
      let bytes:Buffer;
      try { bytes=await readFile(file); } catch { throw new HttpError(404,'Page not found. Build the web app with npm run build.'); }
      const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
      res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','cache-control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});
      res.end(method==='HEAD'?undefined:bytes);
    } catch(error) {
      if(res.headersSent) return res.end();
      const status=error instanceof HttpError?error.status:503;
      if(status===503) console.error(JSON.stringify({event:'request_failed',path:req.url?.split('?')[0]}));
      json(res,status,{error:error instanceof HttpError?error.message:'Service temporarily unavailable. Please retry.'});
    }
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  server.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);clearInterval(cleanup);});
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const server=createApp({secret:process.env.SESSION_SECRET??'',origin:process.env.PUBLIC_ORIGIN??'http://localhost:3000'});
  server.listen(Number(process.env.PORT??3000),'0.0.0.0',()=>console.log(JSON.stringify({event:'api_listening',port:process.env.PORT??3000})));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{server.closeAllConnections();server.close(()=>{void pool.end();});});
}
