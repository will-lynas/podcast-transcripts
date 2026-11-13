import { afterEach, expect, test } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
const clients: Client[] = [];
afterEach(() => { for (const db of clients.splice(0)) db.close(); });
async function setup(apiSecret?: string) {
  const db = createClient({ url: ':memory:' }); clients.push(db);
  await db.executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.executeMultiple(await readFile(new URL('../db/demo.sql', import.meta.url), 'utf8'));
  const { handleRequest } = await import('../src/api.ts');
  return { db, request: (path: string, init?: RequestInit) => handleRequest(new Request('http://localhost'+path, init), db, {apiSecret}) };
}
test('HTTP routing, readiness and sanitized database failure', async () => {
  const { request, db } = await setup();
  expect((await request('/health')).status).toBe(200);
  expect((await request('/v1/sql?q=moon')).status).toBe(404);
  expect((await request('/v1/search?q=moon', {method:'POST'})).status).toBe(405);
  expect((await request('/v1/search?q=moon&padding='+'x'.repeat(2100))).status).toBe(400);
  db.close();
  const failed = await request('/v1/search?q=moon');
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({error:'Service unavailable'});
  expect((await request('/health')).status).toBe(503);
});
test('optional bearer auth is enforced when set and blank configuration fails closed', async () => {
  const { request } = await setup('fictional-test-secret');
  expect((await request('/health')).status).toBe(401);
  expect((await request('/v1/search?q=moon', {headers:{authorization:'Bearer wrong'}})).status).toBe(401);
  expect((await request('/v1/search?q=moon', {headers:{authorization:'Bearer fictional-test-secret'}})).status).toBe(200);
  expect((await (await setup('')).request('/health')).status).toBe(503);
});
test.each(['absentword', 'moon OR carrot', 'moon NOT cheese', 'moon* NEAR(robot)', '\" OR 1=1 --'])('unsafe FTS syntax stays literal / no matches: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect((await response.json()).results).toEqual([]);
});
test('bounded chronological context never crosses episodes and returns 404 for missing passage', async () => {
  const { request } = await setup();
  const response = await request('/v1/context?passage_id=demo-1-p1&window=1');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.demo).toBe(true);
  expect(body.passages.map((r: any) => r.passage_id)).toEqual(['demo-1-p0','demo-1-p1','demo-1-p2']);
  expect(body.passages[1].source_url).toContain('#t=10');
  expect((await (await request('/v1/context?passage_id=demo-1-p0&window=3')).json()).passages).toHaveLength(4);
  expect((await request('/v1/context?passage_id=missing')).status).toBe(404);
  for (const query of ['', '?passage_id=bad%27', '?passage_id=demo-1-p1&window=4', '?passage_id=demo-1-p1&window=-1', '?passage_id=demo-1-p1&window=1.5']) {
    expect((await request('/v1/context'+query)).status).toBe(400);
  }
});
test.each([
  '', '?q=', '?q=%20', '?q=***', '?q='+'x'.repeat(201), '?q='+Array(17).fill('word').join('%20'),
  '?q=moon&mode=raw', '?q=moon&limit=0', '?q=moon&limit=21', '?q=moon&limit=1.2',
  '?q=moon&limit=1e1', '?q=moon&episode_id=', '?q=moon&episode_id=bad%27', '?q=moon&q=cheese', '?q=moon&sql=select'
])('rejects invalid search input %s', async (query) => {
  const { request } = await setup();
  expect((await request('/v1/search'+query)).status).toBe(400);
});
test.each(['all', 'phrase'])('rejects NUL in search q for %s mode', async mode => {
  const { request } = await setup();
  const response = await request('/v1/search?q=moon%00&mode='+mode);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'Invalid parameters'});
});
test('search bounds and parameterized episode filtering', async () => {
  const { request } = await setup();
  expect((await (await request('/v1/search?q=robot&limit=1')).json()).results).toHaveLength(1);
  expect((await (await request('/v1/search?q=robot&episode_id=demo-2')).json()).results.map((r: any) => r.episode_id)).toEqual(['demo-2']);
  expect((await (await request('/v1/search?q=robot&episode_id=missing')).json()).results).toEqual([]);
});
test('phrase search respects order, unlike all-words search', async () => {
  const { request } = await setup();
  const forward = await (await request('/v1/search?q=moon%20cheese&mode=phrase')).json();
  expect(forward.results.map((r: any) => r.passage_id)).toEqual(['demo-1-p1']);
  const reverse = await (await request('/v1/search?q=cheese%20moon&mode=phrase')).json();
  expect(reverse.results).toEqual([]);
});
test('keyword search uses FTS5 and returns timestamped fictional source metadata', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8').catch(() => '');
  expect(schema).toContain('fts5');
  const { request } = await setup();
  const response = await request('/v1/search?q=moon%20cheese');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.demo).toBe(true);
  expect(body.results.map((r: any) => r.passage_id).sort()).toEqual(['demo-1-p1', 'demo-1-p2']);
  expect(body.results.find((r: any) => r.passage_id === 'demo-1-p1')).toMatchObject({episode_id:'demo-1', episode_title:'Fictional Demo: Lunar Kitchen', published_at:'2026-01-01T00:00:00Z', start_ms:10000, end_ms:20000, source_url:'https://example.com/fictional-demo/lunar-kitchen#t=10', text:'FICTIONAL DEMO: The moon cheese sandwich powered a tiny rocket.'});
});
