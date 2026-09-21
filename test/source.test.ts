/**
 * Linked tables: preset expansion, fetching and mapping against a stub, the refresh / source routes,
 * persistence of the source, and documents with a source.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { startServer, type ServerHandle } from '../src/server/server.js';
import { filePersistence } from '../src/server/persistence.js';
import { requestsOf, describePresets } from '../src/source/presets.js';
import { fetchSource, secretNamesOf, envSecrets, mapRecord } from '../src/source/fetch.js';
import { prefetchSources } from '../src/source/prefetch.js';
import { applyDocument } from '../src/build/document.js';
import { FiniDB } from '../src/index.js';
import { openDatabase } from '../src/persist/store.js';
import type { TableSource } from '../src/source/types.js';

// ---- a stub provider: FMP-shaped JSON, versioned so a refresh can change --------------------
let stub: Server; let stubUrl: string; let revenue2026 = 215938e6; let hits = 0;
const income = (symbol: string) => [
  { date: '2026-01-25', symbol, fiscalYear: '2026', period: 'FY', revenue: revenue2026, ebitda: 144552e6, eps: 4.93, epsDiluted: 4.9, weightedAverageShsOutDil: 24514e6 },
  { date: '2025-01-26', symbol, fiscalYear: '2025', period: 'FY', revenue: 130497e6, ebitda: 86137e6, eps: 2.97, epsDiluted: 2.94, weightedAverageShsOutDil: 24804e6 },
];
const balance = (symbol: string) => [{ date: '2026-01-25', symbol, fiscalYear: '2026', period: 'FY', totalDebt: 8468e6, cashAndCashEquivalents: 10605e6 }, { date: '2025-01-26', symbol, fiscalYear: '2025', period: 'FY', totalDebt: 8463e6, cashAndCashEquivalents: 8589e6 }];
before(async () => {
  stub = createServer((req, res) => {
    hits++;
    const u = new URL(req.url!, 'http://x');
    if (u.searchParams.has('apikey') && u.searchParams.get('apikey') !== 'k-123') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ 'Error Message': 'Invalid API KEY.' })); return; }
    const symbol = u.searchParams.get('symbol') ?? 'X';
    const body = u.pathname.endsWith('/income-statement') ? income(symbol) : u.pathname.endsWith('/balance-sheet-statement') ? balance(symbol) : u.pathname.endsWith('/cash-flow-statement') ? [{ date: '2026-01-25', symbol, fiscalYear: '2026', period: 'FY', freeCashFlow: 96676e6 }]
      : u.pathname.endsWith('/profile') ? [{ symbol, companyName: `${symbol} Corp`, price: 222.27, marketCap: 5383601e6, beta: 2.217 }]
      : u.pathname.endsWith('/analyst-estimates') ? [{ symbol, date: '2027-01-31', revenueAvg: 300000e6, epsAvg: 7.1 }]
      : u.pathname === '/csv' ? 'id,name,amount\na,Alpha,1\nb,Beta,2\n' : u.pathname === '/wrapped' ? { data: { items: [{ code: 'x', v: 1 }, { code: 'y', v: 2 }] } } : [];
    res.writeHead(200, { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});
after(() => stub.close());
/** The fmp preset pointed at the stub: same URLs with the host swapped. */
const toStub: typeof fetch = (input, init) => fetch(String(input).replace('https://financialmodelingprep.com/stable', stubUrl), init);
const fmp = (params: Record<string, string>): TableSource => ({ preset: { id: 'fmp', params } });

test('the fmp preset expands tickers × datasets into requests with curated maps and a secret placeholder', () => {
  const reqs = requestsOf(fmp({ symbols: 'NVDA, amd', dataset: 'financials' }));
  assert.equal(reqs.length, 6);
  assert.match(reqs[0].url, /income-statement\?symbol=NVDA&period=annual&limit=10&apikey=\{\{secret:fmp\}\}$/);
  assert.equal(reqs[0].id, 'NVDA_{fiscalYear}');
  assert.equal(reqs[3].constants?.symbol, 'AMD');
  assert.equal(requestsOf(fmp({ symbols: 'NVDA', dataset: 'income', period: 'quarter', limit: '8' }))[0].id, 'NVDA_{fiscalYear}{period}');
  assert.equal(requestsOf(fmp({ symbols: 'NVDA', dataset: 'profile' }))[0].id, 'NVDA');
  assert.deepEqual(secretNamesOf(fmp({ symbols: 'NVDA' })), ['fmp']);
  assert.throws(() => requestsOf(fmp({})), /SOURCE_BAD_PRESET|at least one ticker/);
  assert.throws(() => requestsOf({ preset: { id: 'nope', params: {} } }), /unknown preset/);
  assert.equal(describePresets()[0].id, 'fmp');
  assert.deepEqual(envSecrets({ FMP_API_KEY: 'a', FINIDB_SECRET_CAPIQ: 'b', OTHER: 'c' }), { fmp: 'a', capiq: 'b' });
});

test('mapRecord: map, dotted paths, scale with unscaled fields, transforms, id templates, constants', () => {
  const row = mapRecord({ date: '2027-01-31', revenueAvg: 300000e6, epsAvg: 7.1, nested: { x: '5' } }, { url: '', map: { fiscal_year: { from: 'date', transform: 'year' }, revenue: 'revenueAvg', eps: { from: 'epsAvg', scale: false }, x: { from: 'nested.x', transform: 'number' } }, scale: 1e6, constants: { symbol: 'NVDA' }, id: '{symbol}_{date:year}' }, 0);
  assert.deepEqual(row, { fiscal_year: 2027, revenue: 300000, eps: 7.1, x: 5, symbol: 'NVDA', id: 'NVDA_2027' });
  // no map: every key, slugged; no id: the record's id, else the index
  assert.deepEqual(mapRecord({ 'Total Debt': 3, Name: 'a' }, { url: '' }, 4), { total_debt: 3, name: 'a', id: '5' });
});

test('fetchSource: merges statements by id, applies the map and scale, needs its secret, refuses private hosts', async () => {
  const r = await fetchSource(fmp({ symbols: 'NVDA', dataset: 'financials' }), { secrets: { fmp: 'k-123' }, fetch: toStub, allowPrivate: true });
  assert.equal(r.requests, 3);
  assert.equal(r.rows.length, 2);
  const fy26 = r.rows.find(x => x.id === 'NVDA_2026')!;
  assert.equal(fy26.revenue, 215938);            // $M
  assert.equal(fy26.eps_diluted, 4.9);            // per share: unscaled
  assert.equal(fy26.total_debt, 8468);            // from the balance sheet, merged on the same id
  assert.equal(fy26.fcf, 96676);
  assert.equal(fy26.symbol, 'NVDA');
  assert.equal(fy26.fiscal_year, '2026');         // the preset leaves it a string; the loader types the column
  assert.ok(r.columns.includes('cash') && r.columns.includes('ebitda'));
  const est = await fetchSource(fmp({ symbols: 'NVDA', dataset: 'estimates' }), { secrets: { fmp: 'k-123' }, fetch: toStub, allowPrivate: true });
  assert.deepEqual([est.rows[0].id, est.rows[0].fiscal_year, est.rows[0].revenue], ['NVDA_2027', 2027, 300000]);
  // a plain CSV url and a JSON path
  const csv = await fetchSource({ url: `${stubUrl}/csv` }, { fetch: toStub, allowPrivate: true });
  assert.deepEqual(csv.rows, [{ name: 'Alpha', amount: '1', id: 'a' }, { name: 'Beta', amount: '2', id: 'b' }]);
  const wrapped = await fetchSource({ url: `${stubUrl}/wrapped`, path: 'data.items', id: '{code}' }, { fetch: toStub, allowPrivate: true });
  assert.deepEqual(wrapped.rows.map(x => x.id), ['x', 'y']);
  await assert.rejects(fetchSource(fmp({ symbols: 'NVDA' }), { secrets: {}, fetch: toStub, allowPrivate: true }), (e: any) => e.code === 'SOURCE_NO_SECRET' && e.extra.secrets[0] === 'fmp');
  await assert.rejects(fetchSource(fmp({ symbols: 'NVDA' }), { secrets: { fmp: 'wrong' }, fetch: toStub, allowPrivate: true }), (e: any) => e.code === 'SOURCE_UNAUTHORIZED' && /Invalid API KEY/.test(e.message));
  await assert.rejects(fetchSource({ url: `${stubUrl}/csv` }, { fetch: toStub }), (e: any) => e.code === 'SOURCE_BAD_URL');                     // http
  await assert.rejects(fetchSource({ url: 'https://localhost/x' }, {}), (e: any) => e.code === 'SOURCE_PRIVATE_HOST');
  await assert.rejects(fetchSource({ url: 'https://10.0.0.5/x' }, {}), (e: any) => e.code === 'SOURCE_PRIVATE_HOST');
  await assert.rejects(fetchSource({ url: 'https://user:pw@example.com/x' }, {}), (e: any) => e.code === 'SOURCE_BAD_URL');
});

test('server: refresh links and creates a table, stamps the source, replaces on the next refresh, unlinks; secrets come from the request', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'finidb-src-'));
  const server: ServerHandle = await startServer({ port: 0, host: '127.0.0.1', dataDir, requireAuth: false, fetch: toStub, allowPrivateSources: true, secrets: {}, persistence: filePersistence() });
  const call = async (method: string, path: string, body?: unknown) => { const res = await fetch(server.url + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
  try {
    await call('POST', '/db', { name: 'src' });
    await call('POST', '/db/src/models', { id: 'm', name: 'M' });
    // no secret: 401 that names it, nothing created
    const noKey = await call('POST', '/db/src/tables/nvda/refresh', { source: fmp({ symbols: 'NVDA' }) });
    assert.equal(noKey.status, 401); assert.equal(noKey.body.error.code, 'SOURCE_NO_SECRET'); assert.deepEqual(noKey.body.error.secrets, ['fmp']);
    assert.equal((await call('GET', '/db/src/tables')).body.tables.length, 0);
    // dry run: the plan, nothing written
    const dry = await call('POST', '/db/src/tables/nvda/refresh', { source: fmp({ symbols: 'NVDA' }), secrets: { fmp: 'k-123' }, dryRun: true });
    assert.equal(dry.status, 200); assert.equal(dry.body.created, true); assert.equal(dry.body.toInsert, 2); assert.equal(dry.body.requests, 3);
    assert.equal((await call('GET', '/db/src/tables')).body.tables.length, 0);
    // first refresh creates the table with the fetched rows and typed columns
    const first = await call('POST', '/db/src/tables/nvda/refresh', { source: fmp({ symbols: 'NVDA' }), secrets: { fmp: 'k-123' }, name: 'NVDA financials' });
    assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(first.body.created, true); assert.equal(first.body.inserted, 2);
    assert.equal(first.body.source.status, 'ok'); assert.ok(first.body.source.fetchedAt); assert.equal(first.body.source.fetchedRows, 2);
    const t = (await call('GET', '/db/src/tables/nvda')).body;
    assert.equal(t.name, 'NVDA financials'); assert.equal(t.source.preset.id, 'fmp'); assert.equal(t.rowCount, 2);
    assert.equal(t.fields.find((f: any) => f.id === 'fiscal_year').type, 'number');
    assert.equal(t.fields.find((f: any) => f.id === 'date').type, 'date');
    const cellRes = await call('GET', '/db/src/cells?table=nvda&row=NVDA_2026&field=revenue'); assert.equal(cellRes.body.value, 215938, JSON.stringify(cellRes.body) + ' rows=' + JSON.stringify((await call('GET', '/db/src/tables/nvda/rows?limit=2')).body));
    // a rule reads it like any table
    await call('POST', '/db/src/tables', { model: 'm', id: 'lines', rows: [{ id: 'revenue' }] });
    await call('POST', '/db/src/tables', { model: 'm', id: 'periods', from: { periods: { start: '2025-01', count: 2, grain: 'year' } } });
    const piv = await call('POST', '/db/src/tables', { model: 'm', id: 'is', kind: 'pivot', dims: [{ id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period', measures: [{ id: 'value' }] });
    const rl = await fetch(server.url + '/db/src/tables/is/rules', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'revenue = nvda.revenue[fiscal_year=@period.year]' });
    const rlBody = await rl.json();
    const pc = await call('GET', '/db/src/cells?table=is&line=revenue&period=fy2026');
    assert.equal(pc.body.value, 215938, `pivot=${JSON.stringify(piv.body).slice(0, 200)} rules=${JSON.stringify(rlBody).slice(0, 300)} cell=${JSON.stringify(pc.body)}`);
    // the provider restates; refresh replaces and counts the change; the pivot follows
    revenue2026 = 216000e6;
    const again = await call('POST', '/db/src/tables/nvda/refresh', { secrets: { fmp: 'k-123' } });
    assert.equal(again.status, 201); assert.equal(again.body.mode, 'replace'); assert.equal(again.body.updated, 2); assert.equal(again.body.changed, 1); assert.equal(again.body.deleted, 0);
    assert.equal((await call('GET', '/db/src/cells?table=is&line=revenue&period=fy2026')).body.value, 216000);
    // a failing refresh keeps the rows and records the error on the source
    const bad = await call('POST', '/db/src/tables/nvda/refresh', { secrets: { fmp: 'wrong' } });
    assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'SOURCE_UNAUTHORIZED');
    const after = (await call('GET', '/db/src/tables/nvda')).body;
    assert.equal(after.rowCount, 2); assert.equal(after.source.status, 'error'); assert.match(after.source.error, /SOURCE_UNAUTHORIZED/); assert.ok(after.source.fetchedAt);
    // edit the link without fetching; presets are listed; unlink
    const put = await call('PUT', '/db/src/tables/nvda/source', { source: fmp({ symbols: 'NVDA,AMD' }) });
    assert.equal(put.status, 200); assert.deepEqual(put.body.secrets, ['fmp']); assert.equal(put.body.source.preset.params.symbols, 'NVDA,AMD');
    assert.equal((await call('GET', '/source-presets')).body.presets[0].secret, 'fmp');
    assert.equal((await call('DELETE', '/db/src/tables/nvda/source')).status, 200);
    assert.equal((await call('GET', '/db/src/tables/nvda')).body.source, undefined);
    assert.equal((await call('POST', '/db/src/tables/nvda/refresh', {})).body.error.code, 'SOURCE_NONE');
    // link again so the persistence check below sees a source
    await call('PUT', '/db/src/tables/nvda/source', { source: fmp({ symbols: 'NVDA' }) });
  } finally { await server.close(); }
  // the source survives close and reopen (oplog replay), and a snapshot
  const o = await openDatabase(join(dataDir, 'src'));
  try {
    const t = o.f.model('m').table('nvda');
    assert.equal(t.kind, 'tabular'); assert.equal((t as any).source?.preset?.params?.symbols, 'NVDA'); assert.equal(t.rowCount, 2);
  } finally { await o.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('documents: a table with a source is created linked; prefetchSources fills rows before a local build', async () => {
  const doc = { model: 'm', periods: { start: '2025-01', count: 2, grain: 'year' as const }, tables: { nvda: { source: fmp({ symbols: 'NVDA', dataset: 'income' }) }, lines: { rows: [{ id: 'revenue' }] } }, pivots: { is: { lineTable: 'lines', rules: 'revenue = nvda.revenue[fiscal_year=@period.year]' } } };
  const pre = await prefetchSources(doc as any, { secrets: { fmp: 'k-123' }, fetch: toStub, allowPrivate: true });
  assert.deepEqual(pre.fetched, ['nvda']); assert.equal(pre.failed.length, 0);
  assert.equal((doc.tables.nvda as any).rows.length, 2); assert.equal((doc.tables.nvda as any).source.status, 'ok');
  const f = new FiniDB();
  const r = applyDocument(f, doc as any);
  const t = f.model(r.model).table('nvda') as any;
  assert.equal(t.source.preset.id, 'fmp'); assert.equal(t.rowCount, 2);
  assert.equal(f.get('m', 'is', { line: 'revenue', period: 'fy2026' }), 216000);
  assert.match(r.log.join('\n'), /linked to fmp/);
  // without a secret the build still goes through: an empty linked table and a warning to act on
  const doc2 = { model: 'm', tables: { nvda: { source: fmp({ symbols: 'NVDA' }) } } };
  const pre2 = await prefetchSources(doc2 as any, { secrets: {}, fetch: toStub, allowPrivate: true });
  assert.equal(pre2.failed[0].code, 'SOURCE_NO_SECRET');
  const f2 = new FiniDB(); applyDocument(f2, doc2 as any);
  assert.equal((f2.model('m').table('nvda') as any).source.status, 'error');
});
