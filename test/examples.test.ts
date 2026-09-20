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

test('comparables: one table with LTM and NTM side by side, peer statistics excluding the subject, implied value from the median', () => {
  const { f, r, num } = build('comparables');
  const doc = load('comparables');
  const md = (c: string, l: string) => doc.pivots.market_data.values.find((v: { at: { company: string; line: string } }) => v.at.company === c && v.at.line === l).value as number;
  const fin = (c: string, l: string) => doc.pivots.comps.values.find((v: { at: { company: string; line: string } }) => v.at.company === c && v.at.line === l).value as number;
  const evOf = (c: string) => md(c, 'price') * md(c, 'shares') + md(c, 'debt') - md(c, 'cash');
  assert.ok(Math.abs(num('comps', { company: 'msft', line: 'ev_ebitda_ltm' }) - evOf('msft') / fin('msft', 'ebitda_ltm')) < 1e-9);
  assert.ok(Math.abs(num('comps', { company: 'msft', line: 'ev_ebitda_ntm' }) - evOf('msft') / fin('msft', 'ebitda_ntm')) < 1e-9, 'the NTM multiple uses NTM EBITDA');
  assert.ok(Math.abs(num('comps', { company: 'nvda', line: 'rev_growth_ntm' }) - (fin('nvda', 'revenue_ntm') / fin('nvda', 'revenue_ltm') - 1)) < 1e-9);
  const peers = ['msft', 'googl', 'amzn', 'meta', 'nvda', 'dell', 'hpq'];
  const pes = peers.map(c => md(c, 'price') / fin(c, 'eps_ltm')).sort((a, b) => a - b);
  assert.ok(Math.abs(num('peer_stats', { line: 'pe_ltm', stat: 'median' }) - pes[3]) < 1e-9, 'median P/E over the seven peers, Apple excluded');
  assert.ok(Math.abs(num('peer_stats', { line: 'ev_revenue_ltm', stat: 'median_hardware' }) - (evOf('dell') / fin('dell', 'revenue_ltm') + evOf('hpq') / fin('hpq', 'revenue_ltm')) / 2) < 1e-9);
  const implied = num('implied', { line: 'price_pe_ltm', stat: 'median' });
  assert.ok(Math.abs(implied - pes[3] * fin('aapl', 'eps_ltm')) < 1e-9);
  assert.ok(Math.abs(num('implied', { line: 'upside_pe_ltm', stat: 'median' }) - (implied / md('aapl', 'price') - 1)) < 1e-9);
  const g = r.outputs.find(o => o.title === 'Comparable companies');
  assert.match(g?.markdown ?? '', /Revenue LTM \| Revenue NTM/, 'LTM and NTM sit side by side as columns of one table');
  assert.ok(f.model(r.model).table('stats').hasField('name'));
});

test('precedents: an attribute filter picks recent deals for the median', () => {
  const { num } = build('precedents');
  const recent = [5100 / 158, 1900 / 49, 7800 / 246, 3300 / 98].sort((a, b) => a - b);
  assert.ok(Math.abs(num('summary', { stat: 'median_recent', line: 'ev_ebitda' }) - (recent[1] + recent[2]) / 2) < 1e-9);
  assert.ok(num('implied', { line: 'implied_price' }) > 0);
});

test('salesops: bookings tie to the opportunity table, tranches with accelerators sum to the statement, kickers and SPIFF add on, teams and company roll up, ARR bridge ties', () => {
  const { f, r, num } = build('salesops');
  const doc = load('salesops');
  const opps = doc.tables.opps.rows as { rep: string; acv: number; won: number; new_logo: number; term_years: number; security_addon: number; close_period: string }[];
  const q2 = new Set(['apr26', 'may26', 'jun26']), q3 = new Set(['jul26', 'aug26', 'sep26']);
  const wonIn = (rep: string, q: Set<string>) => opps.filter(o => o.rep === rep && o.won === 1 && q.has(o.close_period));
  const reps = (doc.tables.reps.rows as { id: string; base_rate: number; variable: number; region: string; segment: string }[]);
  // bookings per rep and quarter equal the won ACV in the opportunity table
  for (const rep of reps.slice(0, 6)) {
    const expect = wonIn(rep.id, q2).reduce((s, o) => s + o.acv, 0);
    assert.ok(Math.abs(num('rep_quarterly', { rep: rep.id, quarter: 'q2_2026', line: 'bookings' }) - expect) < 1e-6, `${rep.id} Q2 bookings`);
  }
  // the commission statement: tranches follow the plan bands with multipliers, and the total is their sum
  const plan = (doc.pivots.comp_plan.values as { at: { tranche: string; line: string }; value: number }[]);
  const band = (t: string, l: string) => plan.find(v => v.at.tranche === t && v.at.line === l)!.value;
  const star = reps.map(rp => ({ rp, a: num('rep_quarterly', { rep: rp.id, quarter: 'q2_2026', line: 'attainment' }) })).sort((x, y) => y.a - x.a)[0];
  assert.ok(star.a > 1.25, `top rep exceeds 125% so accelerators apply (${star.a})`);
  const quota = num('rep_quarterly', { rep: star.rp.id, quarter: 'q2_2026', line: 'quota' });
  let expectTotal = 0;
  for (const t of ['t1', 't2', 't3', 't4', 't5']) {
    const inT = Math.max(0, Math.min(star.a, band(t, 'to_pct')) - band(t, 'from_pct'));
    const c = inT * quota * star.rp.base_rate * band(t, 'multiplier');
    assert.ok(Math.abs(num('commissions', { rep: star.rp.id, quarter: 'q2_2026', tranche: t, line: 'commission' }) - c) < 1e-6, `tranche ${t}`);
    expectTotal += c;
  }
  assert.ok(Math.abs(num('commissions', { rep: star.rp.id, quarter: 'q2_2026', tranche: 'total', line: 'commission' }) - expectTotal) < 1e-6);
  assert.ok(num('commissions', { rep: star.rp.id, quarter: 'q2_2026', tranche: 't4', line: 'commission' }) > 0, 'the 125-150% accelerator tranche pays');
  // kickers: new-logo ACV × rate, extra contracted years × ACV × rate, SPIFF only in the SPIFF quarter
  const won = wonIn(star.rp.id, q2);
  const newLogo = won.filter(o => o.new_logo === 1).reduce((s, o) => s + o.acv, 0);
  const extraYears = won.reduce((s, o) => s + o.acv * (o.term_years - 1), 0);
  assert.ok(Math.abs(num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'new_logo_kicker' }) - newLogo * 0.015) < 1e-6);
  assert.ok(Math.abs(num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'multiyear_kicker' }) - extraYears * 0.01) < 1e-6);
  assert.equal(num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'spiff' }), 0, 'no SPIFF outside Q3');
  const spiffDeals = wonIn(star.rp.id, q3).filter(o => o.security_addon === 1).length;
  assert.equal(num('payout', { rep: star.rp.id, quarter: 'q3_2026', line: 'spiff' }), spiffDeals * 2000);
  const uncapped = num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'uncapped_variable' });
  assert.ok(Math.abs(uncapped - (expectTotal + newLogo * 0.015 + extraYears * 0.01)) < 1e-6);
  const total = num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'total_variable' });
  assert.ok(Math.abs(total - Math.min(uncapped, 3 * star.rp.variable / 4)) < 1e-6, 'the payout cap applies');
  assert.ok(Math.abs(num('payout', { rep: star.rp.id, quarter: 'q2_2026', line: 'vs_target' }) - total / (star.rp.variable / 4)) < 1e-9);
  // roll-ups: team = its reps, company = all teams, and the leaderboard is not uniform
  const teamBookings = num('team', { region: 'emea', segment: 'enterprise', quarter: 'q2_2026', line: 'bookings' });
  const repSum = reps.filter(rp => rp.region === 'emea' && rp.segment === 'enterprise').reduce((s, rp) => s + num('rep_quarterly', { rep: rp.id, quarter: 'q2_2026', line: 'bookings' }), 0);
  assert.ok(Math.abs(teamBookings - repSum) < 1e-6);
  const company = num('company_quarterly', { quarter: 'q2_2026', line: 'bookings' });
  assert.ok(Math.abs(company - reps.reduce((s, rp) => s + num('rep_quarterly', { rep: rp.id, quarter: 'q2_2026', line: 'bookings' }), 0)) < 1e-6);
  const atts = reps.map(rp => num('rep_quarterly', { rep: rp.id, quarter: 'q2_2026', line: 'attainment' }));
  assert.ok(Math.max(...atts) > 1.3 && atts.filter(a => a > 0 && a < 0.7).length >= 2, 'attainment is dispersed, not clustered at the mean');
  // ARR bridge ties month to month
  const beg = num('company_monthly', { line: 'beginning_arr', period: 'jun26' }), end = num('company_monthly', { line: 'ending_arr', period: 'jun26' });
  const parts = ['new_arr', 'expansion_arr', 'churned_arr'].map(l => num('company_monthly', { line: l, period: 'jun26' })).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(end - (beg + parts)) < 1e-6 && Math.abs(num('company_monthly', { line: 'beginning_arr', period: 'jul26' }) - end) < 1e-6);
  // the funnel counts every opportunity created in a month
  const created = opps.filter(o => (o as { created_period: string }).created_period === 'may26').length;
  assert.equal(num('company_monthly', { line: 'opps_created', period: 'may26' }), created);
  assert.ok(f.model(r.model).table('accounts').rowCount > 1000);
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
