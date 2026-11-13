import { expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
test('native Node seed is idempotent, HTTP adapter serves real FTS5, missing configuration fails', async () => {
  expect(await readFile(new URL('../scripts/seed.ts', import.meta.url),'utf8').catch(() => '')).toContain('createClient');
  const dir = await mkdtemp(join(tmpdir(),'podcast-transcripts-http-'));
  const databaseUrl = 'file:'+join(dir,'demo.db');
  const env: NodeJS.ProcessEnv = {...process.env, LOCAL_DATABASE_URL:databaseUrl, PORT:'0'};
  delete env.TURSO_DATABASE_URL; delete env.TURSO_AUTH_TOKEN; delete env.API_BEARER_SECRET;
  let server: ReturnType<typeof spawn> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const seed = spawnSync(process.execPath,['scripts/seed.ts'],{env,encoding:'utf8'});
      expect(seed.status,seed.stderr).toBe(0);
    }
    const db = createClient({url:databaseUrl});
    expect(Number((await db.execute('SELECT count(*) AS n FROM passages')).rows[0].n)).toBe(6); db.close();
    server = spawn(process.execPath,['src/local.ts'],{env,stdio:['ignore','pipe','pipe']});
    const url = await new Promise<string>((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timeout')),5000);
      server!.once('exit', code => {clearTimeout(timeout); reject(new Error('Server exited '+code));});
      server!.stdout!.on('data', data => {const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if(match){clearTimeout(timeout); resolve(match[0]);}});
    });
    expect((await fetch(url+'/health')).status).toBe(200);
    const response = await fetch(url+'/v1/search?q=moon%20cheese&mode=phrase');
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: any) => r.passage_id)).toEqual(['demo-1-p1']);
    expect((await fetch(url+'/v1/context?passage_id=demo-1-p1&window=0')).status).toBe(200);
    const missing = {...env}; delete missing.LOCAL_DATABASE_URL;
    expect(spawnSync(process.execPath,['src/local.ts'],{env:missing,encoding:'utf8'}).status).toBe(1);
    expect(spawnSync(process.execPath,['scripts/seed.ts'],{env:{...missing,TURSO_DATABASE_URL:'libsql://fictional.turso.io'},encoding:'utf8'}).status).toBe(1);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server!.once('exit',resolve)); }
    await rm(dir,{recursive:true,force:true});
  }
},15000);
