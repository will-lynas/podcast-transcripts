import type { Client, Row } from '@libsql/client';

export async function handleRequest(request: Request, db: Client, options: {apiSecret?: string} = {}): Promise<Response> {
  try {
    if (options.apiSecret !== undefined) {
      if (!options.apiSecret.trim()) return Response.json({error:'Service unavailable'}, {status:503});
      const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Bearer '+options.apiSecret));
      const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('authorization') ?? ''));
      const a = new Uint8Array(expected), b = new Uint8Array(actual);
      let mismatch = 0;
      for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
      if (mismatch) return Response.json({error:'Unauthorized'}, {status:401, headers:{'WWW-Authenticate':'Bearer'}});
    }
    const response = await route(request, db);
    response.headers.set('Cache-Control','no-store');
    return response;
  } catch {
    return Response.json({error:'Service unavailable'}, {status:503});
  }
}

const columns = `p.passage_id, p.episode_id, p.start_ms, p.end_ms, p.text,
 e.title AS episode_title, e.published_at, e.source_url, e.demo`;
function metadata(row: Row) {
  return { ...row, demo: Boolean(row.demo), source_url: `${row.source_url}#t=${Math.floor(Number(row.start_ms) / 1000)}` };
}
async function route(request: Request, db: Client): Promise<Response> {
  const url = new URL(request.url);
  if (request.url.length > 2048) return Response.json({error:'Invalid parameters'}, {status:400});
  if (request.method !== 'GET') return Response.json({error:'Method not allowed'}, {status:405, headers:{Allow:'GET'}});
  if (!['/health','/v1/search','/v1/context'].includes(url.pathname)) return Response.json({error:'Not found'}, {status:404});
  if (url.pathname === '/health') {
    await db.execute('SELECT rowid FROM passage_fts LIMIT 1');
    return Response.json({status:'ok'});
  }
  if (url.pathname === '/v1/context') {
    const params = url.searchParams;
    const id = params.get('passage_id') ?? '';
    const window = params.get('window') ?? '1';
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !/^[0-3]$/.test(window)
      || [...params.keys()].some(key => !['passage_id','window'].includes(key) || params.getAll(key).length !== 1)) {
      return Response.json({error:'Invalid parameters'}, {status:400});
    }
    const target = (await db.execute({sql:'SELECT episode_id, ordinal FROM passages WHERE passage_id = ?', args:[id]})).rows[0];
    if (!target) return Response.json({error:'Passage not found'}, {status:404});
    const rows = (await db.execute({sql:`SELECT ${columns} FROM passages p JOIN episodes e ON e.episode_id = p.episode_id
      WHERE p.episode_id = ? AND p.ordinal BETWEEN ? AND ? ORDER BY p.ordinal LIMIT 7`,
      args:[String(target.episode_id), Number(target.ordinal)-Number(window), Number(target.ordinal)+Number(window)]})).rows;
    return Response.json({demo:rows.every(row => Boolean(row.demo)), passage_id:id, passages:rows.map(metadata)});
  }
  const q = (url.searchParams.get('q') ?? '').trim();
  const params = url.searchParams;
  const limit = params.get('limit') ?? '10';
  const episode = params.get('episode_id');
  if ([...params.keys()].some(key => !['q','mode','limit','episode_id'].includes(key) || params.getAll(key).length !== 1)
    || !q || q.includes('\0') || q.length > 200 || !/[\p{L}\p{N}]/u.test(q) || q.split(/\s+/u).length > 16
    || !['all','phrase'].includes(params.get('mode') ?? 'all')
    || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 20
    || (episode !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(episode))) {
    return Response.json({error:'Invalid parameters'}, {status:400});
  }
  const rows = (await db.execute({sql: `SELECT ${columns} FROM passage_fts
    JOIN passages p ON p.id = passage_fts.rowid JOIN episodes e ON e.episode_id = p.episode_id
    WHERE passage_fts MATCH ? AND (? IS NULL OR p.episode_id = ?) ORDER BY bm25(passage_fts), p.passage_id LIMIT ?`,
    args: [url.searchParams.get('mode') === 'phrase' ? '"' + q.replaceAll('"', '""') + '"' : q.split(/\s+/u).map(word => '"' + word.replaceAll('"', '""') + '"').join(' AND '), url.searchParams.get('episode_id'), url.searchParams.get('episode_id'), Number(url.searchParams.get('limit') ?? '10')]})).rows;
  return Response.json({demo: rows.length > 0 && rows.every(row => Boolean(row.demo)), results: rows.map(metadata)});
}
