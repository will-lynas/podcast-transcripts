import { afterEach, expect, test } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, {recursive:true, force:true}); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'podcast-transcripts-')); dirs.push(dir);
  const url = 'file:'+join(dir,'test.db');
  const db = createClient({url});
  await db.executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url),'utf8'));
  await db.executeMultiple(await readFile(new URL('../db/demo.sql', import.meta.url),'utf8'));
  db.close();
  const module = await import('../src/worker.ts').catch(() => null);
  expect(module, 'Worker adapter exists').not.toBeNull();
  let calls = 0;
  const worker = module!.createWorker(() => createClient({url}));
  const env = {TURSO_DATABASE_URL:'libsql://fictional.turso.io', TURSO_AUTH_TOKEN:'fictional-test-token', RATE_LIMITER:{limit: async ({key}: {key:string}) => {
    expect(key).toBe('192.0.2.1'); return {success: ++calls <= 30};
  }}};
  const request = (trusted = true) => {
    const req = new Request('https://api.example.com/v1/search?q=moon&mode=phrase', {headers:{'CF-Connecting-IP':'192.0.2.1'}});
    return trusted ? Object.assign(req, {cf:{colo:'TST'}}) : req;
  };
  return {worker, env, request};
}
test('Worker uses real FTS5 database and platform limiter decisions; 31st request is 429', async () => {
  const {worker,env,request} = await setup();
  for (let i = 0; i < 30; i++) {
    const response = await worker.fetch(request(),env);
    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(2);
  }
  const limited = await worker.fetch(request(),env);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
});
test('Worker fails closed without trusted client or production configuration', async () => {
  const {worker,env,request} = await setup();
  expect((await worker.fetch(request(false),env)).status).toBe(503);
  const missingIP = Object.assign(new Request('https://api.example.com/health'), {cf:{colo:'TST'}});
  expect((await worker.fetch(missingIP,env)).status).toBe(503);
  for (const changes of [{TURSO_AUTH_TOKEN:''}, {TURSO_AUTH_TOKEN:undefined}, {TURSO_DATABASE_URL:'file:demo.db'}, {TURSO_DATABASE_URL:undefined}, {RATE_LIMITER:undefined}, {API_BEARER_SECRET:''}]) {
    expect((await worker.fetch(request(), {...env,...changes})).status).toBe(503);
  }
  const failed = await worker.fetch(request(), {...env, RATE_LIMITER:{limit:async () => {throw new Error('secret database details');}}});
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({error:'Service unavailable'});
  expect((await worker.fetch(request(), {...env, API_BEARER_SECRET:'fictional'})).status).toBe(401);
});
