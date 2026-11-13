import { afterEach, expect, test } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
test.each(['absentword', 'moon absentword', 'moo'])('does not relax missing words or use substring matching: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({results:[]});
});
test.each([
  ['moon cheese', ['demo-1-p1', 'demo-1-p2']],
  ['moon AND cheese', ['demo-1-p1', 'demo-1-p2']],
  ['moon OR carrots', ['demo-1-p1', 'demo-1-p2', 'demo-2-p1']],
  ['moon NOT bicycle', ['demo-1-p1']],
  ['rob*', ['demo-1-p0', 'demo-1-p3', 'demo-2-p0']],
  ['moon AND "absentword"', []],
  ['moon "cheese moon"', []],
  ['"OR"', []], ['"AND"', []], ['"NOT"', []],
])('native FTS5 words, operators, phrases and prefixes: %s', async (q, expected) => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect((await response.json()).results.map((r: any) => r.passage_id).sort()).toEqual(expected);
});
test.each(['rob**', '***rob*', '* rob*', '"moon cheese"**'])('normalizes stray/repeated prefix stars: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect((await response.json()).results.map((r: any) => r.passage_id).sort()).toEqual(q.startsWith('"') ? ['demo-1-p1'] : ['demo-1-p0', 'demo-1-p3', 'demo-2-p0']);
});
test.each(['AND moon', 'moon OR', 'NOT moon AND', 'and moon or'])('trims dangling Boolean operators: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect((await response.json()).results.map((r: any) => r.passage_id).sort()).toEqual(['demo-1-p1', 'demo-1-p2']);
});
test.each(['moon.cheese', 'moon-cheese', 'moon_cheese', 'moon-che*'])('quotes compound terms as FTS5 phrases: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(200);
  expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['demo-1-p1']);
});
test('compound cleanup preserves Unicode and multiple quoted phrases', async () => {
  const { request, db } = await setup();
  await db.execute({sql:'INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?)', args:[7, 'test-unicode', 'demo-2', 2, 20000, 30000, 'FICTIONAL TEST: Café étoile 星の庭.']});
  for (const q of ['café-étoile', '"café étoile" 星の庭', '"moon cheese" OR "purple carrots"']) {
    const response = await request('/v1/search?q='+encodeURIComponent(q));
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id).sort()).toEqual(q.includes('OR') ? ['demo-1-p1', 'demo-2-p1'] : ['test-unicode']);
  }
});
test.each(['AND', 'or', 'NOT', 'AND ""', 'AND "..."'])('rejects normalized empty/tokenless queries: %s', async q => {
  const { request, db } = await setup();
  db.close(); // Validation must run before any database access.
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'Invalid parameters'});
});
test.each(['moon OR OR cheese', 'moon AND NOT cheese', '-moon', 'moon`cheese', '" OR 1=1 --'])('returns generic 400 for remaining FTS syntax errors: %s', async q => {
  const { request, db } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'Invalid parameters'});
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(Number((await db.execute('SELECT count(*) AS n FROM passages')).rows[0].n)).toBe(6);
  expect((await request('/health')).status).toBe(200);
});
test('schema failures stay generic 503, not invalid-query errors', async () => {
  const { request, db } = await setup();
  await db.execute('DROP TABLE passage_fts');
  const response = await request('/v1/search?q=moon');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'Service unavailable'});
});
test('missing SQL columns stay generic 503, not FTS syntax errors', async () => {
  const { request, db } = await setup();
  await db.execute('ALTER TABLE episodes RENAME COLUMN published_at TO fictional_date');
  const response = await request('/v1/search?q=moon');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'Service unavailable'});
});
test('real HTTP database transport failures stay generic 503', async () => {
  const server = createServer((_, response) => {
    response.writeHead(503);
    response.end('fictional upstream details: fts5: syntax error near OR');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server');
    const db = createClient({url:`http://127.0.0.1:${address.port}`}); clients.push(db);
    const { handleRequest } = await import('../src/api.ts');
    const response = await handleRequest(new Request('http://localhost/v1/search?q=moon'), db);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'Service unavailable'});
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
test('quoted operators are literal tokens; interior lowercase operators remain words', async () => {
  const { request, db } = await setup();
  await db.execute({sql:'INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?)', args:[7, 'test-operators', 'demo-2', 2, 20000, 30000, 'FICTIONAL TEST: A poet sang AND OR NOT under a blue sun.']});
  for (const q of ['"AND"', '"OR"', '"NOT"', 'poet or sun']) {
    const response = await request('/v1/search?q='+encodeURIComponent(q));
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['test-operators']);
  }
  expect(await (await request('/v1/search?q=moon%20or%20cheese')).json()).toEqual({results:[]});
});
test('dangling-operator cleanup does not split Unicode words', async () => {
  const { request, db } = await setup();
  await db.execute({sql:'INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?)', args:[7, 'test-unicode-operators', 'demo-2', 2, 20000, 30000, 'FICTIONAL TEST: ANDé OR星 NOTétoile.']});
  for (const q of ['ANDé', 'OR星', 'NOTétoile']) {
    const response = await request('/v1/search?q='+encodeURIComponent(q));
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['test-unicode-operators']);
  }
});
test('cleans unquoted punctuation while protecting quoted phrases', async () => {
  const { request } = await setup();
  for (const punctuation of '+{}():"^@/#&|~[]<>,;!?$=\\\'%') {
    const response = await request('/v1/search?q='+encodeURIComponent('moon'+punctuation+'cheese'));
    expect(response.status, punctuation).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id).sort(), punctuation).toEqual(['demo-1-p1', 'demo-1-p2']);
  }
  const response = await request('/v1/search?q='+encodeURIComponent('"moon: cheese"'));
  expect(response.status).toBe(200);
  expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['demo-1-p1']);
});
test('bounded chronological context never crosses episodes and returns 404 for missing passage', async () => {
  const { request } = await setup();
  const response = await request('/v1/context?passage_id=demo-1-p1&window=1');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['passage_id', 'passages']);
  expect(body.passages.every((row: any) => !Object.hasOwn(row, 'demo'))).toBe(true);
  expect(body.passages.map((r: any) => r.passage_id)).toEqual(['demo-1-p0','demo-1-p1','demo-1-p2']);
  expect(body.passages[1].source_url).toContain('#t=10');
  expect((await (await request('/v1/context?passage_id=demo-1-p0&window=3')).json()).passages).toHaveLength(4);
  expect((await request('/v1/context?passage_id=missing')).status).toBe(404);
  for (const query of ['', '?passage_id=bad%27', '?passage_id=demo-1-p1&window=4', '?passage_id=demo-1-p1&window=-1', '?passage_id=demo-1-p1&window=1.5']) {
    expect((await request('/v1/context'+query)).status).toBe(400);
  }
});
test.each([
  '', '?q=', '?q=%20', '?q=***', '?q='+'x'.repeat(201), '?q='+encodeURIComponent('moon'+'!'.repeat(197)),
  '?q='+Array(17).fill('word').join('%20'), '?q='+encodeURIComponent(Array(17).fill('AND').join(' ')),
  '?q=moon&mode=raw', '?q=moon&mode=all', '?q=moon&mode=phrase', '?q=moon&limit=0', '?q=moon&limit=21', '?q=moon&limit=1.2',
  '?q=moon&limit=1e1', '?q=moon&episode_id=', '?q=moon&episode_id=bad%27', '?q=moon&q=cheese', '?q=moon&sql=select'
])('rejects invalid search input %s', async (query) => {
  const { request } = await setup();
  expect((await request('/v1/search'+query)).status).toBe(400);
});
test.each(['moon\0', '"moon\0 cheese"'])('rejects NUL before query normalization: %s', async q => {
  const { request } = await setup();
  const response = await request('/v1/search?q='+encodeURIComponent(q));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'Invalid parameters'});
});
test('search bounds and parameterized episode filtering', async () => {
  const { request } = await setup();
  expect((await (await request('/v1/search?q=robot&limit=1')).json()).results).toHaveLength(1);
  expect((await (await request('/v1/search?q=robot&episode_id=demo-2')).json()).results.map((r: any) => r.episode_id)).toEqual(['demo-2']);
  expect((await (await request('/v1/search?q=robot&episode_id=missing')).json()).results).toEqual([]);
  const response = await request('/v1/search?q='+encodeURIComponent('moon OR carrots')+'&episode_id=demo-2');
  expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['demo-2-p1']);
  for (const q of ['x'.repeat(200), Array(16).fill('moon').join(' ')]) {
    expect((await request('/v1/search?q='+encodeURIComponent(q))).status).toBe(200);
  }
});
test('default and maximum limits preserve real BM25 order, then passage ID', async () => {
  const { request, db } = await setup();
  await db.batch(Array.from({length:25}, (_, i) => ({sql:'INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?, ?)',
    args:[7+i, `test-rank-${i}`, 'demo-2', 2+i, 20000+i*10000, 30000+i*10000, `FICTIONAL TEST: ${'comet '.repeat(1+i%3)}${'dust '.repeat(i%5)}`]})), 'write');
  const ranked = (await db.execute({sql:`SELECT p.passage_id FROM passage_fts JOIN passages p ON p.id = passage_fts.rowid
    WHERE passage_fts MATCH ? ORDER BY bm25(passage_fts), p.passage_id`, args:['com*']})).rows.map(row => row.passage_id);
  for (const [suffix, limit] of [['',10], ['&limit=1',1], ['&limit=20',20]] as const) {
    const response = await request('/v1/search?q=com*'+suffix);
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(ranked.slice(0, limit));
  }
});
test('quoted phrases respect order and mix with ordinary words', async () => {
  const { request } = await setup();
  for (const q of ['"moon cheese"', 'rocket "moon cheese"']) {
    const response = await request('/v1/search?q='+encodeURIComponent(q));
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['demo-1-p1']);
  }
  const reverse = await (await request('/v1/search?q='+encodeURIComponent('"cheese moon"'))).json();
  expect(reverse.results).toEqual([]);
});
test('keyword search uses FTS5 and returns timestamped fictional source metadata', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8').catch(() => '');
  expect(schema).toContain('fts5');
  const { request } = await setup();
  const response = await request('/v1/search?q=moon%20cheese');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['results']);
  expect(body.results.every((row: any) => !Object.hasOwn(row, 'demo'))).toBe(true);
  expect(Object.keys(body.results[0]).sort()).toEqual(['passage_id','episode_id','start_ms','end_ms','text','episode_title','published_at','source_url'].sort());
  expect(body.results.map((r: any) => r.passage_id).sort()).toEqual(['demo-1-p1', 'demo-1-p2']);
  expect(body.results.find((r: any) => r.passage_id === 'demo-1-p1')).toMatchObject({episode_id:'demo-1', episode_title:'Fictional Demo: Lunar Kitchen', published_at:'2026-01-01T00:00:00Z', start_ms:10000, end_ms:20000, source_url:'https://example.com/fictional-demo/lunar-kitchen#t=10', text:'FICTIONAL DEMO: The moon cheese sandwich powered a tiny rocket.'});
});
