import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
async function seed() {
  // A local file OR explicit remote write credentials. Never read the query token.
  const local = process.env.LOCAL_DATABASE_URL;
  const remote = process.env.TURSO_DATABASE_URL;
  if (local && remote) throw new Error('Choose one database');
  const url = local ?? remote;
  if (!url || (local && !local.startsWith('file:'))) throw new Error('Database configuration');
  if (!local) {
    const parsed = new URL(url);
    if (!['libsql:','https:'].includes(parsed.protocol) || !process.env.TURSO_WRITE_AUTH_TOKEN?.trim()) throw new Error('Write credentials');
  }
  const db = createClient({url, authToken:local ? undefined : process.env.TURSO_WRITE_AUTH_TOKEN});
  try {
    await db.executeMultiple(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
    await db.executeMultiple(await readFile(new URL('../db/demo.sql',import.meta.url),'utf8'));
    console.log('Fictional demo seeded. No real transcripts.');
  } finally { db.close(); }
}
seed().catch(() => { console.error('Seed failed: check database configuration and separate write credentials.'); process.exitCode = 1; });
