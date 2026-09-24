import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FiniDB, applyDocument, renderDocumentResult } from '../src/index.js';

const doc = JSON.parse(readFileSync(new URL('../examples/coreweave.json', import.meta.url), 'utf8'));

test('a three-statement model document builds and links across statements', () => {
  for (const engine of ['reference', 'incremental'] as const) {
    const f = new FiniDB({ engine });
    const r = applyDocument(f, doc);
    assert.equal(r.outputs.length, 3);
    const is = r.outputs[0].markdown!;
    assert.match(is, /### Income statement/);
    assert.match(is, /\| revenue \| 15\.8 \| 229 \| 1,915 \| 5,131 \| 8,210 \|/);
    // cross-statement links: interest from prior-period debt, cash from the cash-flow statement
    const g = (t: string, line: string, period: string) => f.get('crwv', t, { line, period }) as number;
    assert.ok(Math.abs(g('income_statement', 'interest_expense', 'fy2026') - 17000 * 0.09) < 1e-6);
    assert.ok(Math.abs(g('balance_sheet', 'debt', 'fy2026') - 26000) < 1e-6);
    assert.ok(Math.abs(g('balance_sheet', 'cash', 'fy2026') - (2400 + g('cash_flow', 'net_change_in_cash', 'fy2026'))) < 1e-6);
    assert.ok(Math.abs(g('cash_flow', 'net_income', 'fy2027') - g('income_statement', 'net_income', 'fy2027')) < 1e-6);
    const md = renderDocumentResult(r);
    assert.match(md, /Units: USD millions/);
    assert.match(md, /finicast\.com\/import/);
  }
});

test('a document with a bad rule fails with the rule named', () => {
  const f = new FiniDB();
  assert.throws(() => applyDocument(f, { periods: { start: '2025-01', count: 2, grain: 'year' }, pivots: { is: { lines: ['a', 'b'], rules: ['b = aa + 1'] } } }), /UNKNOWN_NAME.*aa/);
});

test('json outputs and a re-applied document update inputs', () => {
  const f = new FiniDB();
  const base = { model: 't', periods: { start: '2025-01', count: 3, grain: 'year' as const, histUntil: '2025-12-31' }, pivots: { is: { lines: ['revenue', 'cogs', 'gross_profit'], inputs: { revenue: { fy2025: 100 }, cogs: { fy2025: 40 } }, rules: ['revenue[frame=fcst] = PREV(revenue) * 1.2', 'cogs[frame=fcst] = revenue * 0.4', 'gross_profit = revenue - cogs'] } }, outputs: [{ pivot: 'is', format: 'json' as const }] };
  const r1 = applyDocument(f, base);
  assert.deepEqual(r1.outputs[0].json!.values, [[100, 120, 144], [40, 48, 57.6], [60, 72, 86.4]]);
  const r2 = applyDocument(f, { model: 't', pivots: { is: { inputs: { revenue: { fy2025: 200 } } } }, outputs: [{ pivot: 'is', format: 'json' as const, lines: ['revenue'] }] });
  assert.deepEqual(r2.outputs[0].json!.values, [[200, 240, 288]]);
});

test('a share link carries the model document in its fragment and round-trips', async () => {
  const { modelLink, parseModelLink } = await import('../src/index.js');
  const link = modelLink(doc);
  assert.ok(link.startsWith('https://finicast.com/import#m='), link.slice(0, 40));
  assert.ok(!/[+/=#?&]/.test(link.slice(link.indexOf('#m=') + 3)), 'fragment is base64url with no reserved characters');
  assert.ok(link.length < JSON.stringify(doc).length, `link (${link.length}) shorter than the JSON (${JSON.stringify(doc).length})`);
  assert.deepEqual(parseModelLink(link), doc);
  assert.deepEqual(parseModelLink(link.slice(link.indexOf('#') + 1)), doc);
  assert.equal(modelLink(doc, 'http://localhost:3000/').split('#')[0], 'http://localhost:3000/import');
  // the rendered CLI output tells the agent to include the link verbatim
  const r = applyDocument(new FiniDB(), doc);
  assert.match(renderDocumentResult(r, { link }), /link in your reply verbatim/);
});

test('the uncompressed #j= link form round-trips too', async () => {
  const { modelLinkPlain, parseModelLink } = await import('../src/index.js');
  const link = modelLinkPlain(doc);
  assert.ok(link.startsWith('https://finicast.com/import#j='));
  assert.deepEqual(parseModelLink(link), doc);
});

test('scenarios as a dimension: one set of rules, a bear and a base case side by side', () => {
  const f = new FiniDB();
  const r = applyDocument(f, {
    model: 'sc',
    periods: { start: '2025-01', count: 3, grain: 'year', histUntil: '2025-12-31' },
    tables: { scenarios: { rows: [{ id: 'base', name: 'Base' }, { id: 'bear', name: 'Bear' }] } },
    pivots: {
      history: { lines: ['revenue'], inputs: { revenue: { fy2025: 1000 } } },
      assumptions: { lines: [{ id: 'growth', format: 'percent' }], dims: { scenario: 'scenarios' },
        values: [{ at: { line: 'growth', scenario: 'base', period: 'fy2026' }, value: 0.3 }, { at: { line: 'growth', scenario: 'base', period: 'fy2027' }, value: 0.2 }, { at: { line: 'growth', scenario: 'bear', period: 'fy2026' }, value: 0.05 }, { at: { line: 'growth', scenario: 'bear', period: 'fy2027' }, value: 0.0 }] },
      income_statement: { lines: ['revenue'], dims: { scenario: 'scenarios' }, rules: 'revenue[frame=hist] = history.revenue\nrevenue[frame=fcst] = PREV(revenue) * (1 + assumptions.growth)' },
    },
    outputs: [{ pivot: 'income_statement', pages: { scenario: 'base' }, title: 'Base' }, { pivot: 'income_statement', pages: { scenario: 'bear' }, title: 'Bear' }],
  });
  assert.equal(r.outputs.length, 2);
  assert.ok(Math.abs((f.get('sc', 'income_statement', { line: 'revenue', scenario: 'base', period: 'fy2027' }) as number) - 1560) < 1e-9);
  assert.ok(Math.abs((f.get('sc', 'income_statement', { line: 'revenue', scenario: 'bear', period: 'fy2027' }) as number) - 1050) < 1e-9);
  assert.equal(f.get('sc', 'income_statement', { line: 'revenue', scenario: 'bear', period: 'fy2025' }), 1000, 'history flows into every scenario');
  const text = renderDocumentResult(r, { link: 'https://finicast.com/import#m=x', linkVerified: true, xlsx: 'model.xlsx', rules: 2 });
  assert.match(text, /Deliverables/); assert.match(text, /attach this file/); assert.match(text, /Verified: the link decodes back/); assert.match(text, /from the same 2 rules/);
});

test('a percent line placed on columns formats only its own column', () => {
  const f = new FiniDB();
  const r = applyDocument(f, {
    model: 'colfmt',
    tables: { co: { rows: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
    pivots: { m: { dims: { company: 'co' }, lines: [{ id: 'rev' }, { id: 'growth', format: 'percent' }], values: [
      { at: { company: 'a', line: 'rev' }, value: 1000 }, { at: { company: 'a', line: 'growth' }, value: 0.25 },
      { at: { company: 'b', line: 'rev' }, value: 2500 }, { at: { company: 'b', line: 'growth' }, value: 0.1 } ] } },
    outputs: [{ pivot: 'm', rows: ['company'], cols: ['line'], title: 'By company' }],
  } as never);
  const md = r.outputs[0].markdown ?? '';
  assert.match(md, /\| A \| 1,000 \| 25\.0% \|/, md);
  const g = f.query(r.model, { table: 'm', rows: ['company'], cols: ['line'], format: 'grid' }) as { rowFormats?: (string | undefined)[]; colFormats?: (string | undefined)[]; formats?: (string | undefined)[][] };
  assert.deepEqual(g.rowFormats, [undefined, undefined]);
  assert.deepEqual(g.colFormats, [undefined, 'percent']);
  assert.deepEqual(g.formats?.[0], [undefined, 'percent']);
  assert.ok(f.model(r.model).table('co').hasField('name'), 'row keys become fields');
});

test('a paged percent line is the window fallback format (chart cards paged on a rate)', async () => {
  const { runQuery } = await import('../src/server/server.js');
  const f = new FiniDB();
  const r = applyDocument(f, {
    model: 'pagefmt',
    tables: { co: { rows: [{ id: 'a' }, { id: 'b' }] }, basis: { rows: [{ id: 'ltm' }, { id: 'ntm' }] } },
    pivots: { m: { dims: { company: 'co', basis: 'basis' }, lines: [{ id: 'rev' }, { id: 'growth', format: 'percent' }], values: [
      { at: { company: 'a', line: 'growth', basis: 'ltm' }, value: 0.2 }, { at: { company: 'a', line: 'growth', basis: 'ntm' }, value: 0.1 } ] } },
  } as never);
  const win = runQuery(f, r.model, { table: 'm', rows: ['basis'], cols: ['company'], pages: { line: 'growth' }, format: 'json' } as never) as { formats: (string | undefined)[]; measureFormat?: string };
  assert.deepEqual(win.formats, ['percent', 'percent']);
  assert.equal(win.measureFormat, 'percent');
  const plain = runQuery(f, r.model, { table: 'm', rows: ['basis'], cols: ['company'], pages: { line: 'rev' }, format: 'json' } as never) as { formats: (string | undefined)[] };
  assert.deepEqual(plain.formats, [undefined, undefined]);
});

test('inputs on a pivot without periods are keyed by the other dimension', () => {
  const f = new FiniDB();
  const r = applyDocument(f, {
    model: 'm',
    tables: { companies: { rows: [{ id: 'a', peer: 0 }, { id: 'b', peer: 1 }] } },
    pivots: { md: { dims: { company: 'companies', period: false }, lines: ['price', 'shares', 'cap'], inputs: { price: { a: 10, b: 20 }, shares: { a: 3, b: 4 } }, rules: 'cap = price * shares' } },
  } as any);
  assert.match(r.log.join('\n'), /md: 4 inputs/);
  assert.equal(f.get('m', 'md', { line: 'cap', company: 'b' }), 80);
});

test('a distribution card names its table, field and how it bins', async () => {
  const { normalizeDocument, DocumentError } = await import('../src/build/normalize.js');
  const card = (extra: object) => ({ dashboards: [{ cards: [{ kind: 'distribution', table: 'opps', field: 'acv', ...extra }] }] }) as any;
  assert.equal(normalizeDocument(card({ bins: '14' })).doc.dashboards[0].cards[0].bins, 14);   // "14" is a count, not a quantile
  assert.equal(normalizeDocument(card({ bins: 'deciles', y: 'sum', marks: undefined })).doc.dashboards[0].cards[0].bins, 'deciles');
  assert.throws(() => normalizeDocument(card({ bins: 'thirds' })), (e: any) => e instanceof DocumentError && e.path === 'dashboards[0].cards[0].bins');
  assert.throws(() => normalizeDocument(card({ bins: 1 })), (e: any) => e.path === 'dashboards[0].cards[0].bins');
  assert.throws(() => normalizeDocument(card({ y: 'median' })), (e: any) => e.path === 'dashboards[0].cards[0].y');
  assert.throws(() => normalizeDocument(card({ marks: 'halves' })), (e: any) => e.path === 'dashboards[0].cards[0].marks');
  assert.throws(() => normalizeDocument(card({ tail: 'cut' })), (e: any) => e.path === 'dashboards[0].cards[0].tail');
  assert.throws(() => normalizeDocument({ dashboards: [{ cards: [{ kind: 'distribution', table: 'opps' }] }] } as any), (e: any) => e.path === 'dashboards[0].cards[0].field');
  assert.throws(() => normalizeDocument({ dashboards: [{ cards: [{ kind: 'distribution', field: 'acv' }] }] } as any), (e: any) => e.path === 'dashboards[0].cards[0].table');
});

test('normalizeDocument forgives lists written as objects or strings and names the path of what it cannot read', async () => {
  const { normalizeDocument, DocumentError } = await import('../src/build/normalize.js');
  const doc: any = { model: 'm', pivots: { p: { lines: ['a'], rules: [{ target: 'a', formula: '1' }] } }, outputs: [{ pivot: 'p', rows: { company: '*' }, lines: 'a' }], dashboards: [{ cards: [{ kind: 'table', pivot: 'p', lines: { a: 1, b: 2 }, filters: { line: 'a' } }] }] };
  const r = normalizeDocument(doc);
  assert.deepEqual(r.doc.outputs[0].rows, ['company']);
  assert.deepEqual(r.doc.outputs[0].lines, ['a']);
  assert.deepEqual(r.doc.dashboards[0].cards[0].lines, ['a', 'b']);
  assert.deepEqual(r.doc.dashboards[0].cards[0].filters, { line: ['a'] });
  assert.deepEqual(r.doc.pivots.p.rules, ['a = 1']);
  assert.equal(r.notes.length, 2);
  assert.throws(() => normalizeDocument({ tables: { t: { rows: { id: 'x' } } } } as any), (e: any) => e instanceof DocumentError && e.path === 'tables.t.rows' && /array of row objects/.test(e.message));
  assert.throws(() => normalizeDocument({ pivots: { p: { inputs: { revenue: 5 } } } } as any), (e: any) => e.path === 'pivots.p.inputs.revenue');
  assert.throws(() => normalizeDocument({ outputs: [{ pivot: 'p', rows: 5 }] } as any), (e: any) => e.path === 'outputs[0].rows');
  assert.throws(() => normalizeDocument({ dashboards: { cards: [] } } as any), (e: any) => e.path === 'dashboards');
  // applyDocument reports the same error
  const f = new FiniDB();
  assert.throws(() => applyDocument(f, { model: 'm', tables: { t: { rows: 'nope' } } } as any), /tables.t.rows: must be an array/);
});

test('a pivot with its own line table reads the same-id line of another pivot (peer statistics over a subset of lines)', () => {
  const f = new FiniDB();
  applyDocument(f, {
    model: 'm',
    tables: { companies: { rows: [{ id: 'x', peer: 0 }, { id: 'a', peer: 1 }, { id: 'b', peer: 1 }] }, stats: { rows: [{ id: 'low' }, { id: 'high' }] } },
    pivots: {
      comps: { dims: { company: 'companies', period: false }, lines: ['ev_rev', 'ev_ebitda', 'pe'], inputs: { ev_rev: { x: 1, a: 2, b: 4 }, ev_ebitda: { x: 10, a: 20, b: 30 }, pe: { x: 5, a: 50, b: 70 } } },
      peer_stats: { dims: { stat: 'stats', period: false }, lines: ['ev_ebitda', 'pe'], rules: ['value[stat=low] = MIN(comps.value[company.peer=1])', 'value[stat=high] = MAX(comps.value[company.peer=1])'] },
    },
  } as any);
  assert.equal(f.get('m', 'peer_stats', { line: 'ev_ebitda', stat: 'low' }), 20);
  assert.equal(f.get('m', 'peer_stats', { line: 'ev_ebitda', stat: 'high' }), 30);
  assert.equal(f.get('m', 'peer_stats', { line: 'pe', stat: 'low' }), 50);
  assert.equal(f.get('m', 'peer_stats', { line: 'pe', stat: 'high' }), 70);
});

test('a company × line pivot without periods renders companies on rows by default; a stat × line pivot keeps lines on rows', () => {
  const f = new FiniDB();
  const r = applyDocument(f, {
    model: 'm',
    tables: { companies: { rows: [{ id: 'x', ticker: 'X' }, { id: 'a', ticker: 'A' }] }, stats: { rows: [{ id: 'low' }, { id: 'high' }] } },
    pivots: {
      comps: { dims: { company: 'companies', period: false }, lines: ['ev_rev', 'pe'], inputs: { ev_rev: { x: 1, a: 2 }, pe: { x: 5, a: 50 } } },
      peer_stats: { dims: { stat: 'stats', period: false }, lineTable: 'comps_lines', rules: ['value[stat=low] = MIN(comps.value)', 'value[stat=high] = MAX(comps.value)'] },
    },
    outputs: [{ pivot: 'comps', format: 'both' }, { pivot: 'peer_stats', format: 'both' }],
  } as any);
  assert.deepEqual(r.outputs[0].json!.rows.map(x => x[0]), ['x', 'a']);            // companies down the side
  assert.deepEqual(r.outputs[0].json!.cols, ['ev_rev', 'pe']);                   // metrics across
  assert.deepEqual(r.outputs[1].json!.rows.map(x => x[0]), ['ev_rev', 'pe']);      // statistics: lines down, stats across
  assert.deepEqual(r.outputs[1].json!.cols, ['low', 'high']);
});

test('applying a document twice updates in place: new lines, new rules, new and changed rows, a new pivot', () => {
  const f = new FiniDB();
  const v1: any = { model: 'm', periods: { start: '2024-01', count: 3, grain: 'year', histUntil: '2024-12-31' },
    tables: { drivers: { rows: [{ id: 'g', name: 'Growth', value: 0.1 }] } },
    pivots: { is: { lines: ['revenue'], inputs: { revenue: { fy2024: 100 } }, rules: ['revenue[frame=fcst] = PREV(revenue) * (1 + SUM(drivers.value[id=g]))'] } } };
  applyDocument(f, v1);
  const near = (v: unknown) => Math.round(Number(v) * 1e6) / 1e6;
  assert.equal(near(f.get('m', 'is', { line: 'revenue', period: 'fy2026' })), 121);
  const v2: any = { model: 'm', periods: v1.periods,
    tables: { drivers: { rows: [{ id: 'g', name: 'Growth', value: 0.2 }, { id: 'm', name: 'Margin', value: 0.5 }] } },
    pivots: { is: { lines: ['revenue', { id: 'ebitda', name: 'EBITDA' }, { id: 'margin', format: 'percent' }], inputs: { revenue: { fy2024: 100 } },
      rules: ['revenue[frame=fcst] = PREV(revenue) * (1 + SUM(drivers.value[id=g]))', 'ebitda = revenue * SUM(drivers.value[id=m])', 'margin = ebitda / revenue'] },
      summary: { lines: ['total_ebitda'], dims: { period: false }, rules: ['total_ebitda = SUM(is.ebitda)'] } } };
  const r = applyDocument(f, v2);
  assert.match(r.log.join('\n'), /pivot is: 2 lines added/);
  assert.match(r.log.join('\n'), /table drivers: 1 rows added, 1 updated/);
  assert.equal(near(f.get('m', 'is', { line: 'revenue', period: 'fy2026' })), 144);     // the changed driver
  assert.equal(near(f.get('m', 'is', { line: 'ebitda', period: 'fy2026' })), 72);       // the new line and rule
  assert.equal(f.get('m', 'is', { line: 'margin', period: 'fy2024' }), 0.5);
  assert.equal(near(f.get('m', 'summary', { line: 'total_ebitda' })), 182);             // the new pivot
  assert.equal((f.model('m').table('is_lines') as any).field('format').column.get(2), 'percent');
});
