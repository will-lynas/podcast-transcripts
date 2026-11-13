# Podcast Transcripts

Read-only transcript search API built with TypeScript, SQLite/libSQL FTS5 and Cloudflare Workers. Search returns passages, episode metadata, timestamps and source links; a separate endpoint retrieves neighboring passages.

The included dataset is fictional: two episodes and six passages. Its `example.com` links are placeholders. MCP is not implemented yet.

## Local demo

Requires Node 26.5+ and pnpm 10.28.2. Exact dependencies and lockfile are pinned; the pnpm release cooldown is seven days, lifecycle scripts disabled. No global installs required.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
LOCAL_DATABASE_URL=file:demo.db pnpm seed
LOCAL_DATABASE_URL=file:demo.db pnpm dev
curl --get 'http://127.0.0.1:8787/v1/search' --data-urlencode 'q=rocket "moon cheese"'
curl 'http://127.0.0.1:8787/v1/context?passage_id=demo-1-p1&window=1'
```

The Node adapter binds loopback only, uses native TypeScript support, puts its connection in SQLite `query_only` mode, and has **no rate limiter**. Database files are ignored. The seed command applies `db/schema.sql` and idempotently inserts `db/demo.sql`; never use this demonstration seed on a real corpus. Schema changes/ingest are separate operations, not API endpoints.

## API

- `GET /health`: verifies database/FTS table access.
- `GET /v1/search?q=...&limit=10&episode_id=...`: FTS5 BM25 order, then passage ID. Defaults: ten results; optional episode filter. The former `mode` parameter is rejected.
- `GET /v1/context?passage_id=...&window=1`: ordered passages within the same episode, at most three neighbors on either side (seven passages).

Query: 1–200 characters after trimming, at most 16 whitespace-delimited terms, at least one letter/number, no NUL; these bounds apply before normalization. Requests: at most 2048 URL characters. Limit: 1–20. IDs: 1–80 ASCII letters, digits, underscores or hyphens. Passage text: at most 2000 characters, enforced by schema. Duplicate/unknown search or context parameters are rejected.

`q` supports FTS5 words (implicit AND), mixed double-quoted phrases, uppercase `AND`/`OR`/`NOT` and trailing prefixes: `moon cheese`, `rocket "moon cheese"`, `moon OR carrots`, `moon NOT bicycle`, `rob*`. `NOT` is binary, not a unary exclusion. Quoted operators such as `"OR"` are literal words; a prefix star belongs outside quotes. Interior lowercase operators are ordinary words. Use URL encoding (as above) for quotes and punctuation.

Normalization preserves balanced quoted phrases, replaces unmatched quotes and unquoted punctuation (`+{}():"^@/#&|~[]<>,;!?$=`, backslash, apostrophe and `%`) with spaces, collapses repeated stars and removes leading stars. One dangling AND/OR/NOT at each edge is removed case-insensitively; quote these words to search them literally at an edge. Dotted/hyphenated/underscored terms become phrases (`moon-cheese` matches `"moon cheese"`). Parentheses are cleaned, not grouping syntax. Empty/tokenless normalized queries and remaining malformed syntax return `400`. Tokenization is SQLite `unicode61`: no semantic/substring search, automatic AND-to-OR retry or other zero-result broadening. Normalization is standalone, with no Hermes runtime dependency.

Search returns `{results: [...]}`; context returns `{passage_id, passages: [...]}`. Each passage includes passage/episode IDs, episode title, UTC publication timestamp, start/end milliseconds, text and timestamped source URL; no `demo` field is exposed. Fictional fixture timestamps/links are invented. No matches is `200` with `results: []`; invalid inputs `400`; missing passage/route `404`; wrong method `405`; optional bearer failure `401`; upstream/configuration failure `503` with generic error only. No SQL/write endpoint or query logging.

## Worker configuration

`src/worker.ts` uses `@libsql/client/web`, never local-file fallback. Supply `TURSO_DATABASE_URL` (`libsql://...` or HTTPS) and a **read-only** `TURSO_AUTH_TOKEN` through Worker environment/secrets. The query service issues only SELECTs; database authorization must enforce read-only access. Optional `API_BEARER_SECRET`, if configured, requires `Authorization: Bearer ...` on every route including health; an empty configured secret fails closed. Keep secrets out of files/Git and shell history. `.dev.vars.example` contains placeholders only and is not loaded automatically. The Node adapter accepts only explicit `LOCAL_DATABASE_URL=file:...` and refuses simultaneous remote configuration.

For a separately authorized remote fixture initialization, unset `LOCAL_DATABASE_URL` and supply `TURSO_DATABASE_URL` plus a separate `TURSO_WRITE_AUTH_TOKEN` to `pnpm seed`. The seed script never uses the read-only query token. Do not place the write token in the Worker environment.

`wrangler.toml` configures a per-client `RATE_LIMITER` binding at **30 requests / 60 seconds**, namespace `1001` (choose an unused account namespace before deployment). Every Worker request uses Cloudflare edge metadata plus `CF-Connecting-IP`; missing trusted identity or binding fails closed (`503`). A denied limiter check returns `429` and `Retry-After: 60`. This is Cloudflare's approximate, per-location limiter, **not a strict global quota or spend cap**. Shared IPs share a bucket; trusted upstream Workers/zone routing need identity review before production.

`pnpm bundle` is a local Wrangler dry-run, not deployment or remote validation. Tests exercise real local libSQL FTS5 and the Worker handler with a simulated platform limiter binding; they do not validate Cloudflare's live counters or Turso network/auth. Wrangler preview URLs are disabled; local/preview environments may lack trusted Cloudflare client metadata and intentionally return `503`. Application request logging/Worker observability is disabled; do not enable URL/query logging at a proxy without a privacy review. Set bearer auth before exposing a private corpus. No cloud account, token or deployment is needed for the local demo.
