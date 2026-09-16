import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB, startServer } from '../src/index.js';

function build() {
  const f = new FiniDB();
  f.createModel('m');
  f.createPeriods('m', 'periods', { start: '2026-01', count: 4, grain: 'year', histUntil: '2027-12-31' });
  f.createTable('m', 'lines', [], { rows: [{ id: 'revenue' }, { id: 'cogs' }, { id: 'gross_profit' }, { id: 'growth' }] });
  f.createTable('m', 'ledger', [{ id: 'account' }, { id: 'period', ref: 'periods' }, { id: 'amount', type: 'number' }, { id: 'double', type: 'number', computed: true }], {
    rows: [{ id: '1', account: 'revenue', period: 'fy2026', amount: 100 }, { id: '2', account: 'revenue', period: 'fy2026', amount: 20 }, { id: '3', account: 'cogs', period: 'fy2026', amount: 40 }],
  });
  f.setRules('m', 'ledger', 'double = amount * 2');
  f.createPivot('m', 'is', { dims: [{ id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.setValue('m', 'is', { line: 'growth', period: 'fy2028' }, 0.5);
  f.setRules('m', 'is', `
    revenue[frame=hist] = SUM(ledger.amount[account=revenue])
    cogs[frame=hist]    = SUM(ledger.amount[account=cogs])
    revenue[frame=fcst] = PREV(revenue) * (1 + growth)
    gross_profit        = revenue - cogs
  `);
  return f;
}

test('explain reports source, governing rule and direct precedents', () => {
  const f = build();
  const gp = f.explain('m', 'is', { line: 'gross_profit', period: 'fy2026' });
  assert.equal(gp.value, 80);
  assert.equal(gp.source, 'rule');
  assert.match(gp.rule!.text, /gross_profit = revenue - cogs/);
  assert.deepEqual(gp.precedents.map(p => [p.text, p.value]), [['is.value @ line=revenue, period=fy2026', 120], ['is.value @ line=cogs, period=fy2026', 40]]);

  const rev = f.explain('m', 'is', { line: 'revenue', period: 'fy2026' });
  assert.equal(rev.precedents.length, 1);
  assert.equal(rev.precedents[0].kind, 'rows');
  assert.equal(rev.precedents[0].rowsMatched, 2);
  assert.equal(rev.precedents[0].value, 120);
  assert.ok(rev.referencedBy.some(t => /gross_profit/.test(t)));

  const fc = f.explain('m', 'is', { line: 'revenue', period: 'fy2028' });
  assert.equal(fc.source, 'rule');
  assert.equal(fc.precedents.length, 2);
  assert.equal(fc.precedents[0].at?.period, 'fy2027');   // PREV(revenue)
  assert.equal(fc.precedents[1].at?.line, 'growth');

  const inp = f.explain('m', 'is', { line: 'growth', period: 'fy2028' });
  assert.equal(inp.source, 'input');
  assert.equal(inp.value, 0.5);

  const blank = f.explain('m', 'is', { line: 'growth', period: 'fy2026' });
  assert.equal(blank.source, 'blank');

  const fld = f.explain('m', 'ledger', { id: '2' }, 'double');
  assert.equal(fld.value, 40);
  assert.equal(fld.precedents[0].text, 'ledger.amount @ 2');
});

test('GET /db/:db/explain works over HTTP', async () => {
  const h = await startServer({ port: 0, host: 'localhost' });
  try {
    const post = (path: string, body: unknown) => fetch(`${h.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post('/db', { name: 'x' });
    await post('/db/x/models', { id: 'm' });
    await post('/db/x/tables', { model: 'm', id: 'lines', fields: [], rows: [{ id: 'a' }, { id: 'b' }] });
    await post('/db/x/tables', { model: 'm', id: 'p', kind: 'pivot', dims: [{ id: 'line', table: 'lines' }], lineDim: 'line' });
    const r = await fetch(`${h.url}/db/x/tables/p/rules`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'a = 2\nb = a * 3' });
    assert.ok(r.status < 300, await r.text());
    const e = await (await fetch(`${h.url}/db/x/explain?table=p&line=b`)).json() as any;
    assert.equal(e.value, 6);
    assert.equal(e.precedents[0].value, 2);
  } finally { await h.close(); }
});
