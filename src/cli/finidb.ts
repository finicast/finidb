#!/usr/bin/env node
/**
 * `finidb` command line (doc 07 §5). `serve` runs the HTTP server in-process; every other
 * command talks to a running server over HTTP (base URL from --url, FINIDB_URL, or
 * http://localhost:5488; `finidb://user:pass@host:port/db` connection strings are accepted).
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BOOL_FLAGS = new Set(['require-auth', 'json', 'routes', 'help', 'version', 'append', 'h', 'v']);

interface Args { positional: string[]; flags: Record<string, string | true> }
function parseArgs(argv: string[]): Args {
  const positional: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq >= 0 ? a.slice(0, eq) : a).replace(/^-+/, '');
    if (eq >= 0) flags[key] = a.slice(eq + 1);
    else if (BOOL_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[key] = true;
    else flags[key] = argv[++i];
  }
  return { positional, flags };
}
const str = (v: string | true | undefined, dflt?: string) => (typeof v === 'string' ? v : dflt);

const USAGE = `finidb — a calculation engine for AI agents (doc 07 §5)

  finidb build <model.json> [--format md|json] [--data-dir <dir>]   apply a model document in-process; print the statements and a finicast.com/import#m= link that recreates the model
  finidb mcp [--data-dir <dir>]      MCP server over stdio (in-memory, or persistent with --data-dir / FINIDB_DIR)
  finidb skill [--install <dir>]     print the agent skill (SKILL.md) or copy the skill folder into <dir>, e.g. ~/.claude/skills/finicast
  finidb serve [--port 5488] [--host localhost] [--data-dir ~/.finidb] [--require-auth] [--routes]
  finidb createdb <name>            finidb dropdb <name>            finidb listdb
  finidb createuser <name> --password <p>
  finidb grant <user> <db> <role>   role: read | write | admin  (db '*' = server-wide)
  finidb token                      obtain a bearer token for --user/--password
  finidb schema <db>
  finidb query <db> --table T --rows a[,b] --cols c [--pages dim=member,...] [--measure m] [--format markdown|json] [--title t]
  finidb rules <db> <table> [rules.txt] [--append]   (reads stdin by default; one rule per line; replaces the set)
  finidb load <db> <table> file.csv [--model m] [--id-column x] [--delimiter ,]
  finidb bench [rows]

Connection: --url http://host:port | FINIDB_URL (also finidb://user:pass@host:port/db)
Credentials: --user/--password | FINIDB_USER/FINIDB_PASSWORD | --token/FINIDB_TOKEN
`;

// ---- HTTP client ---------------------------------------------------------------------------

interface Conn { base: string; auth?: string; db?: string }
function connection(flags: Args['flags']): Conn {
  let raw = str(flags.url) ?? process.env.FINIDB_URL ?? 'http://localhost:5488';
  let user = str(flags.user) ?? process.env.FINIDB_USER, pass = str(flags.password) ?? process.env.FINIDB_PASSWORD;
  const token = str(flags.token) ?? process.env.FINIDB_TOKEN;
  let db: string | undefined;
  if (raw.startsWith('finidb://')) {
    const u = new URL(raw.replace(/^finidb:/, 'http:'));
    if (u.username) { user = decodeURIComponent(u.username); pass = decodeURIComponent(u.password); }
    db = u.pathname.replace(/^\//, '') || undefined;
    raw = `http://${u.host}`;
  }
  const auth = token ? `Bearer ${token}` : user ? `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` : undefined;
  return { base: raw.replace(/\/$/, ''), auth, db };
}

async function api(conn: Conn, method: string, path: string, body?: unknown, contentType?: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (conn.auth) headers.Authorization = conn.auth;
  let payload: string | undefined;
  if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); headers['Content-Type'] = contentType ?? (typeof body === 'string' ? 'text/plain' : 'application/json'); }
  let res: Response;
  try { res = await fetch(conn.base + path, { method, headers, body: payload }); }
  catch (e) { fail(`cannot reach ${conn.base}: ${(e as Error).message}\nis the server running? try: finidb serve`); }
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson && text ? JSON.parse(text) : text;
  if (!res.ok) fail(isJson && data?.error ? `${data.error.code}: ${data.error.message}${data.error.fix ? `\n  fix: ${data.error.fix}` : ''}` : `${res.status} ${text}`);
  return data;
}
function fail(msg: string): never { console.error(`finidb: ${msg}`); process.exit(1); }
const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// ---- commands --------------------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (flags.version || flags.v) { const pkg = JSON.parse(readFileSync(resolve(here(), '../../package.json'), 'utf8')); console.log(pkg.version); return; }
  if (!cmd || flags.help || flags.h || cmd === 'help') { console.log(USAGE); return; }
  const conn = connection(flags);

  switch (cmd) {
    case 'serve': {
      const { startServer, ROUTES } = await import('../server/server.js');
      const { filePersistence } = await import('../server/persistence.js');
      if (flags.routes) { for (const [m, p, need] of ROUTES) console.log(`${m.padEnd(6)} ${p.padEnd(44)} ${need}`); return; }
      const host = str(flags.host, 'localhost')!;
      const handle = await startServer({
        port: Number(str(flags.port, '5488')), host,
        dataDir: str(flags['data-dir']) ?? process.env.FINIDB_DATA_DIR ?? join(homedir(), '.finidb'),
        requireAuth: flags['require-auth'] === true ? true : undefined,
        persistence: flags['no-persist'] === true ? undefined : filePersistence(),
        log: line => console.error(line),
      });
      const stop = async () => { console.error('\nshutting down'); await handle.close(); process.exit(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return;
    }
    case 'createdb': { const name = rest[0] ?? fail('usage: finidb createdb <name>'); out(await api(conn, 'POST', '/db', { name })); return; }
    case 'dropdb': { const name = rest[0] ?? fail('usage: finidb dropdb <name>'); out(await api(conn, 'DELETE', `/db/${enc(name)}`)); return; }
    case 'listdb': {
      const r = await api(conn, 'GET', '/db');
      if (flags.json) return out(r);
      if (!r.databases.length) return console.log('(no databases)');
      for (const d of r.databases) console.log(`${d.name.padEnd(24)} v${String(d.version).padEnd(8)} models=${d.models}  role=${d.role ?? '-'}  created ${d.created}`);
      return;
    }
    case 'createuser': {
      const name = rest[0] ?? fail('usage: finidb createuser <name> --password <p>');
      const password = str(flags.password) ?? fail('--password required');
      out(await api(conn, 'POST', '/users', { name, password })); return;
    }
    case 'grant': {
      const [user, db, role] = rest;
      if (!user || !db || !role) fail('usage: finidb grant <user> <db> <role>');
      out(await api(conn, 'POST', '/grants', { user, db, role })); return;
    }
    case 'token': { out(await api(conn, 'POST', '/auth/token')); return; }
    case 'schema': { const db = rest[0] ?? conn.db ?? fail('usage: finidb schema <db>'); out(await api(conn, 'GET', `/db/${enc(db)}/schema`)); return; }
    case 'query': {
      const db = rest[0] ?? conn.db ?? fail('usage: finidb query <db> --table T --rows a --cols b');
      const table = str(flags.table) ?? fail('--table required');
      const list = (v: string | true | undefined) => (typeof v === 'string' && v ? v.split(',') : []);
      const pages: Record<string, string> = {};
      for (const kv of list(flags.pages ?? flags.page)) { const [k, v] = kv.split('='); pages[k] = v; }
      const format = str(flags.format, 'markdown');
      const body: Record<string, unknown> = { table, rows: list(flags.rows), cols: list(flags.cols), pages, measure: str(flags.measure), title: str(flags.title), model: str(flags.model), format };
      out(await api(conn, 'POST', `/db/${enc(db)}/query`, body)); return;
    }
    case 'rules': {
      const [db, table, file] = rest;
      if (!db || !table) fail('usage: finidb rules <db> <table> [rules.txt]   (stdin by default)');
      const text = readFileSync(file ?? 0, 'utf8');
      const r = await api(conn, flags.append ? 'POST' : 'PUT', `/db/${enc(db)}/tables/${enc(table)}/rules`, text, 'text/plain');
      if (flags.json) return out(r);
      for (const x of r.rules) console.log(`${x.status === 'ok' ? 'ok     ' : 'INVALID'} ${x.target}${x.when.length ? '[' + x.when.map((c: any) => `${c.left}${c.op}${c.right}`).join(', ') + ']' : ''} = ${x.formula}${x.error ? '   ' + x.error : ''}`);
      return;
    }
    case 'load': {
      const [db, table, file] = rest;
      if (!db || !table || !file) fail('usage: finidb load <db> <table> file.csv [--model m]');
      const q = new URLSearchParams();
      if (str(flags.model)) q.set('model', str(flags.model)!);
      if (str(flags['id-column'])) q.set('idColumn', str(flags['id-column'])!);
      if (str(flags.delimiter)) q.set('delimiter', str(flags.delimiter)!);
      const r = await api(conn, 'POST', `/db/${enc(db)}/tables/${enc(table)}/load${q.size ? '?' + q : ''}`, readFileSync(file, 'utf8'), 'text/csv');
      if (flags.json) return out(r);
      console.log(`${r.created ? 'created' : 'loaded into'} ${r.table}: ${r.inserted} rows (total ${r.rowCount}), id column: ${r.idColumn ?? 'generated'}`);
      for (const f of r.profile) console.log(`  ${String(f.id).padEnd(24)} ${String(f.type).padEnd(7)} distinct=${f.distinct} nulls=${f.nullCount}${r.fields.find((x: any) => x.id === f.id)?.ref ? '  -> ' + r.fields.find((x: any) => x.id === f.id).ref : ''}`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
      return;
    }
    case 'build': {
      const file = rest[0] ?? fail('usage: finidb build <model.json> [--format md|json] [--data-dir <dir>] [--site https://finicast.com]');
      const { readFileSync } = await import('node:fs');
      const doc = JSON.parse(file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8'));
      const { applyDocument, renderDocumentResult } = await import('../build/document.js');
      const { FiniDB } = await import('../index.js');
      let f: InstanceType<typeof FiniDB>; let closer: (() => Promise<void>) | undefined;
      if (flags['data-dir']) { const { openDatabase } = await import('../persist/store.js'); const o = await openDatabase(String(flags['data-dir'])); f = o.f; closer = () => o.close(); }
      else f = new FiniDB();
      try {
        const r = applyDocument(f, doc);
        const { modelLink } = await import('../build/link.js');
        const link = modelLink(doc, str(flags.site));
        if (str(flags.format) === 'json') console.log(JSON.stringify({ ok: true, ...r, link }, null, 1));
        else console.log(renderDocumentResult(r, { link, dashboard: !!doc.dashboards }));
      } catch (e) { console.error(`Build failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
      finally { if (closer) await closer(); }
      return;
    }
    case 'mcp': {
      const main = resolve(here(), '../mcp/main.js');
      const env = { ...process.env, ...(flags['data-dir'] ? { FINIDB_DIR: String(flags['data-dir']) } : {}) };
      const child = spawn(process.execPath, [main], { stdio: 'inherit', env });
      child.on('exit', code => process.exit(code ?? 0));
      return;
    }
    case 'skill': {
      const { readFileSync, cpSync, mkdirSync, existsSync } = await import('node:fs');
      const skillDir = resolve(here(), '../../skill');
      if (!existsSync(skillDir)) fail('skill folder not found in this installation');
      if (flags.install) {
        const dest = resolve(String(flags.install));
        mkdirSync(dest, { recursive: true });
        cpSync(skillDir, dest, { recursive: true });
        console.log(`installed the Finicast skill into ${dest}`);
      } else console.log(readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8'));
      return;
    }
    case 'bench': {
      const run = resolve(here(), '../../bench/run.ts');
      const child = spawn(process.execPath, ['--import', 'tsx', run, ...(rest[0] ? [rest[0]] : [])], { stdio: 'inherit' });
      child.on('exit', code => process.exit(code ?? 0));
      return;
    }
    default: fail(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}
const here = () => dirname(fileURLToPath(import.meta.url));
const enc = encodeURIComponent;

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });   // `finidb ... | head`
main().catch(e => fail(e instanceof Error ? e.message : String(e)));
