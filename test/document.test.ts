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
  assert.match(renderDocumentResult(r, { link }), /include this link verbatim/);
});

test('the uncompressed #j= link form round-trips too', async () => {
  const { modelLinkPlain, parseModelLink } = await import('../src/index.js');
  const link = modelLinkPlain(doc);
  assert.ok(link.startsWith('https://finicast.com/import#j='));
  assert.deepEqual(parseModelLink(link), doc);
});
