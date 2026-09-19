import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FiniDB, applyDocument, isError, exportWorkbook } from '../src/index.js';

/** Every recipe on /for-agents ships as an example document; each must build with no cell errors and produce the numbers it claims. */
const load = (name: string) => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
function build(name: string) {
  const f = new FiniDB();
  const r = applyDocument(f, load(name));
  const errors = r.outputs.flatMap(o => (o.errors ?? []).map(e => `${o.title}: #${e.code} ${e.message ?? ''} (${e.cells})`));
  assert.deepEqual(errors, [], `${name} has cell errors`);
  const num = (pivot: string, at: Record<string, string>, measure?: string) => { const v = measure ? f.get(r.model, pivot, at, measure) : f.get(r.model, pivot, at); assert.ok(!isError(v), `${pivot} ${JSON.stringify(at)}: ${JSON.stringify(v)}`); return v as number; };
  return { f, r, num };
}

test('dcf: discounting, terminal value and the NPV cross-check agree', () => {
  const { num } = build('dcf');
  const ev = num('valuation', { line: 'enterprise_value' });
  const sumPv = num('valuation', { line: 'sum_pv_fcf' }), pvTv = num('valuation', { line: 'pv_terminal' });
  assert.ok(Math.abs(ev - (sumPv + pvTv)) < 1e-6);
  assert.ok(Math.abs(num('valuation', { line: 'npv_check' }) - sumPv) < 1e-6, 'NPV() over the forecast FCF equals the explicit discounting');
  const df = num('fcf', { line: 'discount_factor', period: 'fy2027' });
  assert.ok(Math.abs(df - 1 / 1.09 ** 2) < 1e-9, 'discount factor uses the period index');
  assert.ok(num('valuation', { line: 'per_share' }) > 0 && num('valuation', { line: 'terminal_share' }) > 0.5);
});

test('comparables: LTM and NTM multiples, peer statistics excluding the subject, implied value from the median', () => {
  const { f, r, num } = build('comparables');
  const doc = load('comparables');
  const md = (c: string, l: string) => doc.pivots.market_data.values.find((v: { at: { company: string; line: string } }) => v.at.company === c && v.at.line === l).value as number;
  const fin = (c: string, l: string, b: string) => doc.pivots.financials.values.find((v: { at: { company: string; line: string; basis: string } }) => v.at.company === c && v.at.line === l && v.at.basis === b).value as number;
  const evOf = (c: string) => md(c, 'price') * md(c, 'shares') + md(c, 'debt') - md(c, 'cash');
  assert.ok(Math.abs(num('comps', { company: 'msft', line: 'ev_ebitda', basis: 'ltm' }) - evOf('msft') / fin('msft', 'ebitda', 'ltm')) < 1e-9);
  assert.ok(Math.abs(num('comps', { company: 'msft', line: 'ev_ebitda', basis: 'ntm' }) - evOf('msft') / fin('msft', 'ebitda', 'ntm')) < 1e-9, 'NTM multiple uses NTM EBITDA');
  assert.ok(Math.abs(num('comps', { company: 'nvda', line: 'rev_growth', basis: 'ntm' }) - (fin('nvda', 'revenue', 'ntm') / fin('nvda', 'revenue', 'ltm') - 1)) < 1e-9);
  const peers = ['msft', 'googl', 'amzn', 'meta', 'nvda', 'dell', 'hpq'];
  const pes = peers.map(c => md(c, 'price') / fin(c, 'eps', 'ltm')).sort((a, b) => a - b);
  assert.ok(Math.abs(num('peer_stats', { line: 'pe', stat: 'median', basis: 'ltm' }) - pes[3]) < 1e-9, 'median P/E over the seven peers, Apple excluded');
  assert.ok(Math.abs(num('peer_stats', { line: 'ev_revenue', stat: 'median_hardware', basis: 'ltm' }) - (evOf('dell') / fin('dell', 'revenue', 'ltm') + evOf('hpq') / fin('hpq', 'revenue', 'ltm')) / 2) < 1e-9);
  const implied = num('implied', { line: 'price_from_pe', stat: 'median', basis: 'ltm' });
  assert.ok(Math.abs(implied - pes[3] * fin('aapl', 'eps', 'ltm')) < 1e-9);
  assert.ok(Math.abs(num('implied', { line: 'upside_pe', stat: 'median', basis: 'ltm' }) - (implied / md('aapl', 'price') - 1)) < 1e-9);
  const stats = f.model(r.model).table('stats');
  assert.ok(stats.hasField('name') && stats.rowCount === 6, 'undeclared row keys such as name become fields');
  const g = r.outputs.find(o => o.title === 'Peer statistics — LTM');
  assert.match(g?.markdown ?? '', /Median: platforms/, 'column headers use the member names');
});

test('precedents: an attribute filter picks recent deals for the median', () => {
  const { num } = build('precedents');
  const recent = [5100 / 158, 1900 / 49, 7800 / 246, 3300 / 98].sort((a, b) => a - b);
  assert.ok(Math.abs(num('summary', { stat: 'median_recent', line: 'ev_ebitda' }) - (recent[1] + recent[2]) / 2) < 1e-9);
  assert.ok(num('implied', { line: 'implied_price' }) > 0);
});

test('salesops: territories from account attributes, points through two references, tiered commissions', () => {
  const { f, r, num } = build('salesops');
  const pts = num('territory_plan', { territory: 'west-enterprise', line: 'activity_points', period: 'q1_2026' });
  assert.ok(pts > 0);
  // every activity is scored: the sum over territories and quarters equals the sum of the activity scores
  const doc = load('salesops');
  const totalPoints = ['west-enterprise', 'west-smb', 'east-enterprise', 'east-smb'].flatMap(t => ['q1_2026', 'q2_2026', 'q3_2026', 'q4_2026'].map(p => num('territory_plan', { territory: t, line: 'activity_points', period: p }))).reduce((a, b) => a + b, 0);
  const expected = doc.tables.activities.rows.reduce((s: number, a: { activity_type: string }) => s + doc.tables.activity_types.rows.find((t: { id: string }) => t.id === a.activity_type).points, 0);
  assert.ok(Math.abs(totalPoints - expected) < 1e-9, `${totalPoints} vs ${expected}`);
  const total = num('commissions', { rep: 'ana', tranche: 'total', line: 'commission' });
  const parts = ['t1', 't2', 't3'].map(t => num('commissions', { rep: 'ana', tranche: t, line: 'commission' })).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - parts) < 1e-6);
  assert.ok(f.model(r.model).table('territories').kind === 'tabular');
});

test('budget vs actual: actuals from the ledger, variance lines, and a text measure for commentary', () => {
  const { f, r, num } = build('budget-vs-actual');
  const actual = num('bva', { subsidiary: 'us', department: 'sales', line: 'revenue', version: 'actual', period: 'mar26' });
  const budget = num('bva', { subsidiary: 'us', department: 'sales', line: 'revenue', version: 'budget', period: 'mar26' });
  assert.ok(actual > 0 && budget > 0);
  assert.ok(Math.abs(num('bva', { subsidiary: 'us', department: 'sales', line: 'revenue', version: 'variance', period: 'mar26' }) - (actual - budget)) < 1e-6);
  const c = f.get(r.model, 'bva', { subsidiary: 'us', department: 'engineering', line: 'cloud', version: 'variance', period: 'mar26' }, 'comment');
  assert.match(String(c), /GPU cluster/);
  assert.ok(r.outputs.some(o => o.title === 'Manager commentary' && /GPU cluster/.test(o.markdown ?? '')));
});

test('ledger to model: CSV with a date column, periods derived, actuals then plan', () => {
  const { num } = build('ledger-to-model');
  const jun = num('model', { subsidiary: 'us', department: 'sales', line: 'revenue', period: 'jun26' });
  const jul = num('model', { subsidiary: 'us', department: 'sales', line: 'revenue', period: 'jul26' });
  assert.ok(jun > 0 && Math.abs(jul - jun * 1.02) < 1e-6, 'plan grows from the last actual');
  assert.ok(Math.abs(num('model', { subsidiary: 'us', department: 'sales', line: 'total', period: 'jun26' }) - (['revenue', 'salaries', 'cloud', 'travel'].map(l => num('model', { subsidiary: 'us', department: 'sales', line: l, period: 'jun26' })).reduce((a, b) => a + b, 0))) < 1e-6);
});

test('scenarios: one rule set, three cases, history shared', () => {
  const { num } = build('scenarios');
  assert.ok(Math.abs(num('income_statement', { scenario: 'base', line: 'revenue', period: 'fy2026' }) - 5131 * 1.9) < 1e-6);
  assert.ok(Math.abs(num('income_statement', { scenario: 'bear', line: 'revenue', period: 'fy2026' }) - 5131 * 1.4) < 1e-6);
  assert.equal(num('income_statement', { scenario: 'bull', line: 'revenue', period: 'fy2025' }), 5131);
  assert.ok(num('sensitivity', { scenario: 'bull', line: 'revenue_fy2028' }) > num('sensitivity', { scenario: 'bear', line: 'revenue_fy2028' }));
});

test('every example exports to a workbook without value-only cells', () => {
  for (const name of ['dcf', 'comparables', 'precedents', 'salesops', 'budget-vs-actual', 'ledger-to-model', 'scenarios', 'coreweave']) {
    const f = new FiniDB();
    const r = applyDocument(f, load(name));
    const x = exportWorkbook(f.db, r.model);
    assert.ok(x.formulas > 0, `${name}: no formulas`);
    assert.equal(x.values, 0, `${name}: ${x.notes.join(' | ')}`);
  }
});
