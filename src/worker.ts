import { createClient } from '@libsql/client/web';
import type { RateLimit } from '@cloudflare/workers-types';
import { handleRequest } from './api.ts';
export interface Env {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  API_BEARER_SECRET?: string;
  RATE_LIMITER?: RateLimit;
}
// The factory seam lets tests use real local libSQL, not fabricated search results.
export function createWorker(factory: typeof createClient = createClient) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(env.TURSO_DATABASE_URL ?? '');
        if (!['libsql:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
          || !env.TURSO_AUTH_TOKEN?.trim() || !env.RATE_LIMITER
          || (env.API_BEARER_SECRET !== undefined && !env.API_BEARER_SECRET.trim())) throw new Error('Configuration');
        // Only trust Cloudflare's edge-injected identity, not arbitrary forwarded headers.
        const cf = (request as Request & {cf?: {colo?: string}}).cf;
        const client = request.headers.get('CF-Connecting-IP');
        if (!cf?.colo || !client?.trim() || client.length > 64) throw new Error('Client identity');
        if (!(await env.RATE_LIMITER.limit({key:client})).success) {
          return Response.json({error:'Rate limit exceeded'}, {status:429, headers:{'Retry-After':'60','Cache-Control':'no-store'}});
        }
        const db = factory({url:env.TURSO_DATABASE_URL!, authToken:env.TURSO_AUTH_TOKEN});
        try { return await handleRequest(request, db, {apiSecret:env.API_BEARER_SECRET}); }
        finally { db.close(); }
      } catch {
        return Response.json({error:'Service unavailable'}, {status:503, headers:{'Cache-Control':'no-store'}});
      }
    }
  };
}
export default createWorker();
