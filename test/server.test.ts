/**
 * HTTP server tests (doc 07 §2, §3): a real server on an ephemeral port, driven with global fetch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, ServerHandle } from '../src/server/server.js';
import { AuthStore } from '../src/server/auth.js';

let server: ServerHandle;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'finidb-test-'));
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir, requireAuth: false });
});
after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });

interface Res { status: number; body: any; text: string; headers: Headers }
async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; base?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...init.headers };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    if (typeof init.body === 'string' || init.body instanceof FormData) body = init.body as BodyInit;
    else { body = JSON.stringify(init.body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch((init.base ?? server.url) + path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : undefined, text, headers: res.headers };
}
const ok = async (path: string, init: Parameters<typeof api>[1] = {}, expect = 200) => {
  const r = await api(path, init);
  assert.equal(r.status, expect, `${init.method ?? 'GET'} ${path}: ${r.text.slice(0, 300)}`);
  return r;
};

// the NVDA model from test/nvda.test.ts, expressed as REST calls
async function buildNvda(db: string) {
  await ok(`/db/${db}/models`, { body: { id: 'nvda' } }, 201);
  await ok(`/db/${db}/tables`, { body: { model: 'nvda', id: 'periods', from: { periods: { start: '2024-01', count: 6, grain: 'year', histUntil: '2026-12-31' } } } }, 201);
  await ok(`/db/${db}/tables`, { body: { model: 'nvda', id: 'is_lines', fields: [{ id: 'name' }, { id: 'category' }], rows: [
    { id: 'revenue', name: 'Revenue', category: 'flow' }, { id: 'cogs', name: 'COGS', category: 'flow' },
    { id: 'gross_profit', name: 'Gross Profit', category: 'flow' }, { id: 'rnd', name: 'R&D', category: 'opex' },
    { id: 'sga', name: 'SG&A', category: 'opex' }, { id: 'opex', name: 'Opex', category: 'flow' },
    { id: 'ebit', name: 'EBIT', category: 'flow' }, { id: 'tax', name: 'Tax', category: 'flow' },
    { id: 'net_income', name: 'Net Income', category: 'flow' }, { id: 'gross_margin', name: 'Gross Margin', category: 'ratio' },
    { id: 'cum_ni', name: 'Cumulative NI', category: 'flow' },
  ] } }, 201);
  await ok(`/db/${db}/tables`, { body: { model: 'nvda', id: 'financials', fields: [{ id: 'account' }, { id: 'period', ref: 'periods' }, { id: 'amount', type: 'number' }] } }, 201);
  await ok(`/db/${db}/tables/financials/rows`, { body: [
    { id: '1', account: 'revenue', period: 'fy2024', amount: 60922 }, { id: '2', account: 'cogs', period: 'fy2024', amount: 16621 },
    { id: '3', account: 'rnd', period: 'fy2024', amount: 8675 }, { id: '4', account: 'sga', period: 'fy2024', amount: 2654 },
    { id: '5', account: 'revenue', period: 'fy2025', amount: 130497 }, { id: '6', account: 'cogs', period: 'fy2025', amount: 32639 },
    { id: '7', account: 'rnd', period: 'fy2025', amount: 12914 }, { id: '8', account: 'sga', period: 'fy2025', amount: 3491 },
    { id: '9', account: 'revenue', period: 'fy2026', amount: 180000 }, { id: '10', account: 'cogs', period: 'fy2026', amount: 45000 },
    { id: '11', account: 'rnd', period: 'fy2026', amount: 16000 }, { id: '12', account: 'sga', period: 'fy2026', amount: 4000 },
    { id: '13', account: 'revenue', period: 'fy2025', amount: 3 },
  ] }, 201);
  await ok(`/db/${db}/tables`, { body: { id: 'drivers', fields: [{ id: 'name' }], rows: [{ id: 'revenue_growth' }, { id: 'cogs_pct' }, { id: 'opex_growth' }, { id: 'tax_rate' }] } }, 201);
  await ok(`/db/${db}/tables`, { body: { id: 'assumptions', kind: 'pivot', dims: [{ id: 'driver', table: 'drivers' }, { id: 'period', table: 'periods' }], lineDim: 'driver', timeDim: 'period' } }, 201);
  const cells = [];
  for (const p of ['fy2027', 'fy2028', 'fy2029']) {
    cells.push({ table: 'assumptions', at: { driver: 'revenue_growth', period: p }, value: 0.4 }, { table: 'assumptions', at: { driver: 'cogs_pct', period: p }, value: 0.25 },
      { table: 'assumptions', at: { driver: 'opex_growth', period: p }, value: 0.1 }, { table: 'assumptions', at: { driver: 'tax_rate', period: p }, measure: 'value', value: 0.15 });
  }
  await ok(`/db/${db}/cells`, { body: cells });
  await ok(`/db/${db}/tables`, { body: { id: 'income_statement', kind: 'pivot', dims: [{ id: 'line', table: 'is_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period', measures: [{ id: 'value' }] } }, 201);
  const rules = `
    revenue[frame=hist]      = SUM(financials.amount[account=revenue])
    cogs[frame=hist]         = SUM(financials.amount[account=cogs])
    rnd[frame=hist]          = SUM(financials.amount[account=rnd])
    sga[frame=hist]          = SUM(financials.amount[account=sga])
    revenue[frame=fcst]      = PREV(revenue) * (1 + assumptions.revenue_growth)
    cogs[frame=fcst]         = revenue * assumptions.cogs_pct
    rnd[frame=fcst]          = PREV(rnd) * (1 + assumptions.opex_growth)
    sga[frame=fcst]          = PREV(sga) * (1 + assumptions.opex_growth)
    gross_profit             = revenue - cogs
    opex                     = SUM(value[line.category = opex])
    ebit                     = gross_profit - opex
    tax                      = IF(ebit > 0, ebit * assumptions.tax_rate, 0)
    net_income               = ebit - tax
    gross_margin             = gross_profit / revenue
    cum_ni                   = CUMSUM(net_income)
  `;
  const r = await ok(`/db/${db}/tables/income_statement/rules`, { method: 'PUT', body: rules, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.body.rules.length, 15);
  assert.ok(r.body.rules.every((x: any) => x.status === 'ok'));
}
const cell = async (db: string, table: string, at: Record<string, string>) => (await ok(`/db/${db}/cells?table=${table}&${new URLSearchParams(at)}`)).body.value;

test('health and database lifecycle', async () => {
  const h = await ok('/health');
  assert.equal(h.body.ok, true);
  assert.match(h.headers.get('server-timing') ?? '', /engine;dur=\d/);
  await ok('/db', { body: { name: 'nvda' } }, 201);
  assert.equal((await api('/db', { body: { name: 'nvda' } })).status, 409);
  assert.equal((await api('/db', { body: { name: 'bad name' } })).status, 400);
  const list = await ok('/db');
  assert.deepEqual(list.body.databases.map((d: any) => d.name), ['nvda']);
  const missing = await api('/db/nope/schema');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'DB_NOT_FOUND');
  assert.equal((await api('/db/nvda/schema', { method: 'DELETE' })).status, 405);
});

test('builds the NVDA model over REST and reads cells', async () => {
  await buildNvda('nvda');
  assert.equal(await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2025' }), 130500);
  assert.equal(await cell('nvda', 'income_statement', { line: 'opex', period: 'fy2024' }), 8675 + 2654);
  assert.ok(Math.abs((await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2029' })) - 180000 * 1.4 ** 3) < 1e-6);
  const row = await ok('/db/nvda/cells?table=financials&row=5&field=period');
  assert.equal(row.body.value, 'fy2024'.replace('4', '5'));
});

test('query renders markdown and the columnar json window', async () => {
  const md = await ok('/db/nvda/query', { body: { table: 'income_statement', rows: ['line'], cols: ['period'], title: 'NVDA', formats: { gross_margin: 'percent' } } });
  assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
  assert.match(md.text, /## NVDA/);
  assert.match(md.text, /\| Revenue/);
  assert.match(md.text, /FY2029/);
  assert.match(md.text, /75\.0%/);
  assert.match(md.headers.get('server-timing') ?? '', /engine;dur=/);

  const wrapped = await ok('/db/nvda/query', { body: { table: 'income_statement', rows: ['line'], cols: ['period'] }, headers: { Accept: 'application/json' } });
  assert.match(wrapped.body.markdown, /\| Revenue/);

  const j = await ok('/db/nvda/query', { body: { table: 'income_statement', rows: ['line'], cols: ['period'], format: 'json' } });
  const w = j.body;
  assert.deepEqual(w.rows[0], ['revenue']);
  assert.deepEqual(w.cols.map((c: string[]) => c[0]), ['fy2024', 'fy2025', 'fy2026', 'fy2027', 'fy2028', 'fy2029']);
  assert.equal(w.rowLabels[0][0], 'Revenue');
  assert.equal(w.values.length, 11 * 6);
  assert.equal(w.state.length, 11 * 6);
  assert.equal(w.values[1], 130500);          // revenue × fy2025, row-major
  assert.equal(w.state[1], 1);                // computed
  assert.equal(typeof w.version, 'number');

  const filtered = await ok('/db/nvda/query', { body: { table: 'income_statement', rows: ['line'], cols: ['period'], filters: { line: ['ebit'], period: ['fy2024'] }, format: 'json' } });
  assert.deepEqual(filtered.body.rows, [['ebit']]);
  assert.equal(filtered.body.values[0], 60922 - 16621 - 8675 - 2654);

  const bad = await api('/db/nvda/query', { body: { table: 'income_statement', rows: ['nope'], cols: ['period'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'QUERY_NO_DIM');
});

test('setting inputs and cells propagates; state marks inputs', async () => {
  const before = await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2028' });
  await ok('/db/nvda/cells', { body: { table: 'income_statement', at: { line: 'revenue', period: 'fy2027' }, value: 1000 } });
  assert.equal(await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2027' }), 1000);
  assert.ok(Math.abs((await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2028' })) - 1400) < 1e-6);
  assert.notEqual(before, 1400);
  const j = await ok('/db/nvda/query', { body: { table: 'income_statement', rows: ['line'], cols: ['period'], filters: { line: ['revenue'] }, format: 'json' } });
  assert.equal(j.body.state[3], 2);           // fy2027 is now an input
  // clear it again
  await ok('/db/nvda/cells', { body: { table: 'income_statement', at: { line: 'revenue', period: 'fy2027' }, clear: true } });
  assert.ok(Math.abs((await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2027' })) - 180000 * 1.4) < 1e-6);
  // PATCH rows → setCell on a tabular table; the ledger sum moves
  await ok('/db/nvda/tables/financials/rows', { method: 'PATCH', body: [{ id: '13', amount: 5 }] });
  assert.equal(await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2025' }), 130502);
  await ok('/db/nvda/cells', { body: { table: 'financials', row: '13', field: 'amount', value: 3 } });
  assert.equal(await cell('nvda', 'income_statement', { line: 'revenue', period: 'fy2025' }), 130500);
});

test('schema describes models, tables, fields, dims, measures, rules and row counts', async () => {
  const s = (await ok('/db/nvda/schema')).body;
  assert.equal(s.name, 'nvda');
  assert.equal(s.models.length, 1);
  const tables = Object.fromEntries(s.models[0].tables.map((t: any) => [t.id, t]));
  assert.equal(tables.financials.kind, 'tabular');
  assert.equal(tables.financials.rowCount, 13);
  assert.equal(tables.financials.fields.find((f: any) => f.id === 'period').ref, 'periods');
  assert.equal(tables.income_statement.kind, 'pivot');
  assert.deepEqual(tables.income_statement.dims.map((d: any) => d.id), ['line', 'period']);
  assert.deepEqual(tables.income_statement.measures.map((m: any) => m.id), ['value']);
  assert.equal(tables.income_statement.lineDim, 'line');
  assert.equal(tables.income_statement.timeDim, 'period');
  assert.equal(tables.income_statement.rules.length, 15);
  assert.equal(tables.income_statement.rules[0].target, 'value');
  assert.deepEqual(tables.income_statement.rules[0].when.map((c: any) => c.left), ['line', 'frame']);
  const t = (await ok('/db/nvda/tables/periods?limit=2')).body;
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].id, 'fy2024');
  assert.equal(t.rows[0].frame, 'hist');
});

test('rules: append, structured replace, compile errors are 400 with a code', async () => {
  const bad = await api('/db/nvda/tables/income_statement/rules', { body: 'ebit = gross_profit - opexx', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.code);
  assert.match(bad.body.error.message, /opexx|UNKNOWN_NAME/);
  const parse = await api('/db/nvda/tables/income_statement/rules', { body: 'ebit = = 1', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(parse.status, 400);
  // the failed append did not disturb the rule set
  assert.equal((await ok('/db/nvda/tables/income_statement/rules')).body.rules.length, 15);
  // structured append then delete by order
  // a rejected append must not poison pre-existing rules either (ebit is shadowed by the bad rule during the smoke test)
  assert.ok((await cell('nvda', 'income_statement', { line: 'tax', period: 'fy2027' })) > 0);
  const r = await ok('/db/nvda/tables/income_statement/rules', { body: { rules: [{ target: 'value', when: [{ left: 'line', op: '=', right: 'tax' }, { left: 'frame', op: '=', right: 'fcst' }], formula: '0' }] } }, 201);
  assert.equal(r.body.rules.length, 1);
  assert.equal((await ok('/db/nvda/tables/income_statement/rules')).body.rules.length, 16);
  assert.equal(await cell('nvda', 'income_statement', { line: 'tax', period: 'fy2027' }), 0);
  await ok('/db/nvda/tables/income_statement/rules/15', { method: 'DELETE' });
  assert.equal((await ok('/db/nvda/tables/income_statement/rules')).body.rules.length, 15);
  assert.ok((await cell('nvda', 'income_statement', { line: 'tax', period: 'fy2027' })) > 0);
  assert.equal((await api('/db/nvda/tables/income_statement/rules/99', { method: 'DELETE' })).status, 404);
});

test('changes long-poll resolves after a write', async () => {
  const v = (await ok('/db/nvda/schema')).body.version as number;
  const immediate = await ok(`/db/nvda/changes?since=${v - 1}`);
  assert.equal(immediate.body.changed, true);
  const t0 = Date.now();
  const pending = ok(`/db/nvda/changes?since=${v}`);
  await new Promise(r => setTimeout(r, 120));
  await ok('/db/nvda/cells', { body: { table: 'assumptions', at: { driver: 'tax_rate', period: 'fy2028' }, value: 0.2 } });
  const ch = await pending;
  assert.ok(Date.now() - t0 >= 100);
  assert.ok(ch.body.version > v);
  assert.equal(ch.body.changed, true);
  assert.ok(ch.body.tables.includes('assumptions'));
  const timeout = await ok(`/db/nvda/changes?since=${ch.body.version}&timeout=150`);
  assert.equal(timeout.body.changed, false);
  assert.equal(timeout.body.version, ch.body.version);
});

test('batch applies facade ops in order and reports the failing index', async () => {
  const r = await ok('/db/nvda/batch', { body: [
    { method: 'setValue', args: ['nvda', 'assumptions', { driver: 'revenue_growth', period: 'fy2027' }, 0.5] },
    { method: 'get', args: ['nvda', 'income_statement', { line: 'revenue', period: 'fy2027' }] },
    { method: 'setValue', args: ['nvda', 'assumptions', { driver: 'revenue_growth', period: 'fy2027' }, 0.4] },
  ] });
  assert.equal(r.body.results.length, 3);
  assert.ok(Math.abs(r.body.results[1].value - 180000 * 1.5) < 1e-6);
  const bad = await api('/db/nvda/batch', { body: [{ method: 'get', args: ['nvda', 'income_statement', { line: 'revenue', period: 'fy2024' }] }, { method: 'dropEverything', args: [] }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'UNKNOWN_OP');
  assert.equal(bad.body.error.index, 1);
});

test('CSV load creates a table with a profile, detects refs, and appends via multipart', async () => {
  const csv = 'id,period,dept,amount\n1,fy2024,eng,10.5\n2,fy2025,ops,20\n';
  const r = await ok('/db/nvda/tables/expenses/load', { body: csv, headers: { 'Content-Type': 'text/csv' } }, 201);
  assert.equal(r.body.created, true);
  assert.equal(r.body.inserted, 2);
  assert.equal(r.body.rowCount, 2);
  assert.equal(r.body.idColumn, 'id');
  assert.equal(r.body.profile.length, 4);
  assert.equal(r.body.profile.find((p: any) => p.id === 'amount').type, 'number');
  assert.equal(r.body.fields.find((f: any) => f.id === 'period').ref, 'periods');   // all values are period ids
  assert.equal(r.body.fields.find((f: any) => f.id === 'dept').ref, undefined);     // 'eng'/'ops' are nobody's ids
  const rows = (await ok('/db/nvda/tables/expenses/rows')).body;
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows[0].period, 'fy2024');
  assert.equal(rows.rows[0].amount, 10.5);

  const fd = new FormData();
  fd.append('file', new Blob(['id,period,dept,amount\n3,fy2026,eng,30\n4,fy2026,ops,40\n'], { type: 'text/csv' }), 'more.csv');
  const more = await ok('/db/nvda/tables/expenses/load', { body: fd }, 201);
  assert.equal(more.body.created, false);
  assert.equal(more.body.rowCount, 4);
  assert.equal((await ok('/db/nvda/cells?table=expenses&row=4&field=period')).body.value, 'fy2026');

  // the loaded table is immediately usable from a rule
  await ok('/db/nvda/tables/income_statement/rules', { body: 'cum_ni = SUM(expenses.amount)', headers: { 'Content-Type': 'text/plain' } }, 201);
  assert.equal(await cell('nvda', 'income_statement', { line: 'cum_ni', period: 'fy2026' }), 70);
});

test('auth: 401 when required, grants gate writes, bearer tokens, auth.json persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finidb-auth-'));
  const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, requireAuth: true });
  const base = s.url;
  const basic = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
  try {
    const anon = await api('/db', { base });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'AUTH_REQUIRED');
    assert.match(anon.headers.get('www-authenticate') ?? '', /Basic/);
    assert.equal((await api('/db', { base, body: { name: 'x' } })).status, 401);
    assert.equal((await api('/health', { base })).status, 200);

    // bootstrap the superuser through the handle (what `finidb init` will do)
    s.auth.createUser('root', 'rootpw');
    s.auth.grant('root', '*', 'admin');
    assert.equal((await api('/db', { base, headers: basic('root', 'wrong') })).status, 401);
    await ok('/db', { base, headers: basic('root', 'rootpw'), body: { name: 'x' } }, 201);
    await ok('/users', { base, headers: basic('root', 'rootpw'), body: { name: 'writer', password: 'wp' } }, 201);
    await ok('/users', { base, headers: basic('root', 'rootpw'), body: { name: 'reader', password: 'rp' } }, 201);
    await ok('/grants', { base, headers: basic('root', 'rootpw'), body: { user: 'writer', db: 'x', role: 'write' } });
    await ok('/grants', { base, headers: basic('root', 'rootpw'), body: { user: 'reader', db: 'x', role: 'read' } });

    // writer can mutate; reader can read but not mutate; neither is a superuser
    await ok('/db/x/models', { base, headers: basic('writer', 'wp'), body: { id: 'm' } }, 201);
    assert.equal((await ok('/db/x/schema', { base, headers: basic('reader', 'rp') })).body.models.length, 1);
    const forbidden = await api('/db/x/models', { base, headers: basic('reader', 'rp'), body: { id: 'm2' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'AUTH_FORBIDDEN');
    assert.equal((await api('/db/x/batch', { base, headers: basic('reader', 'rp'), body: [{ method: 'createModel', args: ['m3'] }] })).status, 403);
    assert.equal((await api('/db/x/batch', { base, headers: basic('reader', 'rp'), body: [{ method: 'query', args: ['m', { table: 'nope', rows: [], cols: [] }] }] })).status, 404);
    assert.equal((await api('/users', { base, headers: basic('reader', 'rp'), body: { name: 'evil', password: 'x' } })).status, 403);
    assert.equal((await api('/db/x', { base, method: 'DELETE', headers: basic('writer', 'wp') })).status, 403);
    // a user who creates a database becomes its admin
    await ok('/db', { base, headers: basic('writer', 'wp'), body: { name: 'mine' } }, 201);
    await ok('/db/mine', { base, method: 'DELETE', headers: basic('writer', 'wp') });
    // listing shows only granted databases
    assert.deepEqual((await ok('/db', { base, headers: basic('reader', 'rp') })).body.databases.map((d: any) => d.name), ['x']);

    // bearer token
    const tok = await ok('/auth/token', { base, method: 'POST', headers: basic('writer', 'wp') });
    assert.ok(tok.body.token);
    await ok('/db/x/tables', { base, headers: { Authorization: `Bearer ${tok.body.token}` }, body: { model: 'm', id: 't', fields: [{ id: 'v', type: 'number' }] } }, 201);
    assert.equal((await api('/db/x/schema', { base, headers: { Authorization: 'Bearer nope' } })).status, 401);
    const who = await ok('/auth/whoami', { base, headers: { Authorization: `Bearer ${tok.body.token}` } });
    assert.equal(who.body.user, 'writer');
    assert.equal(who.body.superuser, false);
  } finally { await s.close(); }
  // credentials and grants survive a restart
  const store = new AuthStore(dir);
  assert.equal(store.verify('writer', 'wp'), 'writer');
  assert.equal(store.verify('writer', 'nope'), undefined);
  assert.equal(store.roleOn({ user: 'reader', trusted: false }, 'x'), 'read');
  rmSync(dir, { recursive: true, force: true });
});
