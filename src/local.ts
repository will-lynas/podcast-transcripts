import { createServer } from 'node:http';
import { createClient } from '@libsql/client';
import { handleRequest } from './api.ts';
async function start() {
  const url = process.env.LOCAL_DATABASE_URL;
  if (!url?.startsWith('file:') || process.env.TURSO_DATABASE_URL
    || (process.env.API_BEARER_SECRET !== undefined && !process.env.API_BEARER_SECRET.trim())) throw new Error('Local configuration');
  const port = process.env.PORT ?? '8787';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('Port');
  const db = createClient({url});
  await db.execute('PRAGMA query_only = ON');
  const server = createServer(async (req,res) => {
    try {
      const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
        method:req.method, headers:typeof req.headers.authorization === 'string' ? {authorization:req.headers.authorization} : {}
      });
      const response = await handleRequest(request, db, {apiSecret:process.env.API_BEARER_SECRET});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      res.writeHead(503, {'Content-Type':'application/json'});
      res.end('{"error":"Service unavailable"}');
    }
  });
  server.on('error', () => { console.error('Local server failed.'); db.close(); process.exitCode=1; });
  server.listen(Number(port),'127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`Local API http://127.0.0.1:${address.port} (development only; no rate limiting)`);
  });
  const stop = () => server.close(() => {db.close();});
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
}
start().catch(() => { console.error('Local startup failed: set LOCAL_DATABASE_URL=file:demo.db and seed separately.'); process.exitCode=1; });
