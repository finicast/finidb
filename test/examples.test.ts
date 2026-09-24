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

test('dcf: mid-year discounting, two terminal value methods with their cross-checks, and sensitivity tables that agree with the base case', () => {
  const { num } = build('dcf');
  const w = num('wacc', { line: 'wacc' }), g = num('wacc', { line: 'terminal_growth' });
  assert.ok(Math.abs(w - (0.85 * (0.042 + 1.15 * 0.045) + 0.15 * 0.055 * 0.75)) < 1e-12, 'WACC from the build-up');
  assert.ok(Math.abs(num('fcf', { line: 'discount_factor', period: 'fy2027' }) - 1 / (1 + w) ** 1.5) < 1e-12, 'mid-year discount factor');
  const ev = num('valuation', { method: 'perpetuity', line: 'enterprise_value' });
  const sumPv = num('valuation', { method: 'perpetuity', line: 'sum_pv_ufcf' }), pvTv = num('valuation', { method: 'perpetuity', line: 'pv_terminal' });
  assert.ok(Math.abs(ev - (sumPv + pvTv)) < 1e-9);
  const last = num('fcf', { line: 'ufcf', period: 'fy2030' }), ebitdaLast = num('fcf', { line: 'ebitda', period: 'fy2030' });
  assert.ok(Math.abs(num('valuation', { method: 'perpetuity', line: 'terminal_value' }) - last * (1 + g) / (w - g)) < 1e-9);
  assert.ok(Math.abs(num('valuation', { method: 'exit_multiple', line: 'terminal_value' }) - ebitdaLast * 16) < 1e-9);
  // cross-checks: the implied growth of the exit-multiple terminal value reproduces that terminal value under the perpetuity formula
  const tvX = num('valuation', { method: 'exit_multiple', line: 'terminal_value' }), gX = num('valuation', { method: 'exit_multiple', line: 'implied_growth' });
  assert.ok(Math.abs(last * (1 + gX) / (w - gX) - tvX) < 1e-6, 'implied perpetuity growth');
  assert.ok(Math.abs(num('valuation', { method: 'perpetuity', line: 'implied_multiple' }) - num('valuation', { method: 'perpetuity', line: 'terminal_value' }) / ebitdaLast) < 1e-9);
  // the base cell of each sensitivity table equals the valuation summary's price per share
  const perShare = num('valuation', { method: 'perpetuity', line: 'per_share' });
  assert.ok(Math.abs(num('sensitivity_growth', { wacc_case: 'w_base', growth_case: 'g_base', line: 'per_share' }) - perShare) < 1e-6, 'sensitivity base = summary (perpetuity)');
  assert.ok(Math.abs(num('sensitivity_multiple', { wacc_case: 'w_base', multiple_case: 'm_base', line: 'per_share' }) - num('valuation', { method: 'exit_multiple', line: 'per_share' })) < 1e-6, 'sensitivity base = summary (exit multiple)');
  assert.ok(num('sensitivity_growth', { wacc_case: 'w_m100', growth_case: 'g_p100', line: 'per_share' }) > perShare && num('sensitivity_growth', { wacc_case: 'w_p100', growth_case: 'g_m100', line: 'per_share' }) < perShare, 'the table slopes the right way');
  assert.ok(Math.abs(num('valuation', { method: 'perpetuity', line: 'premium' }) - (perShare / 58 - 1)) < 1e-9);
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
  const g = r.outputs.find(o => o.title === 'Financial performance');
  assert.match(g?.markdown ?? '', /Revenue LTM \| Revenue NTM/, 'LTM and NTM sit side by side as columns of one table');
  assert.match(r.outputs.find(o => o.title === 'Valuation and multiples')?.markdown ?? '', /EV \/ EBITDA LTM \(x\) \| EV \/ EBITDA NTM \(x\)/);
  assert.ok(f.model(r.model).table('stats').hasField('name'));
});

test('precedents: multiples from the deal table, statistics over the set and its subsets, the implied valuation at each statistic', () => {
  const { num } = build('precedents');
  const doc = load('precedents');
  const deals = doc.tables.deals.rows as { id: string; ev: number; target_ebitda: number; target_revenue: number; type: string; year: number; premium_1d: number }[];
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const evEbitda = deals.map(d => d.ev / d.target_ebitda);
  assert.ok(Math.abs(num('multiples', { deal: 'd06', line: 'ev_ebitda' }) - 5100 / 158) < 1e-9);
  assert.ok(Math.abs(num('summary', { line: 'ev_ebitda', stat: 'median' }) - med(evEbitda)) < 1e-9);
  assert.ok(Math.abs(num('summary', { line: 'ev_ebitda', stat: 'high' }) - Math.max(...evEbitda)) < 1e-9);
  assert.ok(Math.abs(num('summary', { line: 'ev_ebitda', stat: 'median_sponsor' }) - med(deals.filter(d => d.type === 'sponsor').map(d => d.ev / d.target_ebitda))) < 1e-9, 'the sponsor subset');
  assert.ok(Math.abs(num('summary', { line: 'premium_1d', stat: 'median_recent' }) - med(deals.filter(d => d.year >= 2025).map(d => d.premium_1d))) < 1e-9, 'the recent subset');
  const subject = Object.fromEntries((doc.pivots.subject.values as { at: { line: string }; value: number }[]).map(v => [v.at.line, v.value]));
  const price = (med(evEbitda) * subject.ebitda - subject.net_debt) / subject.shares;
  assert.ok(Math.abs(num('implied', { line: 'price_from_ebitda', stat: 'median' }) - price) < 1e-9, 'implied price at the median EV/EBITDA');
  assert.ok(Math.abs(num('implied', { line: 'premium_from_ebitda', stat: 'median' }) - (price / subject.price - 1)) < 1e-9);
  assert.ok(Math.abs(num('implied', { line: 'price_from_premium', stat: 'median' }) - subject.price * (1 + med(deals.map(d => d.premium_1d)))) < 1e-9);
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

test('ledger to model: actuals from the CSV, driver-based forecast, budget beside it, year-to-date and full-year roll-ups', () => {
  const { num } = build('ledger-to-model');
  const doc = load('ledger-to-model');
  const plan = (line: string) => (doc.pivots.plan.values as { at: { line: string; period: string }; value: number }[]).find(v => v.at.line === line && v.at.period === 'sep26')!.value;
  const heads = (sub: string, dept: string, line: string, p: string) => (doc.pivots.headcount.values as { at: Record<string, string>; value: number }[]).find(v => v.at.subsidiary === sub && v.at.department === dept && v.at.line === line && v.at.period === p)!.value;
  // actuals: August US revenue equals the ledger's August US revenue lines
  const csv = (doc.tables.ledger.csv as string).trim().split('\n').slice(1).map(l => l.split(','));
  const augRev = csv.filter(r => r[1].startsWith('2026-08') && r[2] === 'us' && r[3] === 'company' && r[4] === 'revenue').reduce((s, r) => s + Number(r[5]), 0);
  assert.ok(Math.abs(num('model', { subsidiary: 'us', department: 'company', line: 'revenue', period: 'aug26' }) - augRev) < 1e-6);
  // forecast: revenue grows from the last actual; salaries follow the headcount plan; cloud is a share of revenue
  const sep = num('model', { subsidiary: 'us', department: 'company', line: 'revenue', period: 'sep26' });
  assert.ok(Math.abs(sep - augRev * (1 + plan('revenue_growth'))) < 1e-6);
  assert.ok(Math.abs(num('model', { subsidiary: 'us', department: 'engineering', line: 'salaries', period: 'sep26' }) + heads('us', 'engineering', 'heads', 'sep26') * heads('us', 'engineering', 'cost_per_head', 'sep26') / 12) < 1e-6);
  assert.ok(Math.abs(num('model', { subsidiary: 'us', department: 'engineering', line: 'cloud', period: 'sep26' }) + sep * plan('cloud_pct')) < 1e-6);
  assert.equal(num('model', { subsidiary: 'us', department: 'sales', line: 'cloud', period: 'sep26' }), 0, 'cloud is forecast only where it is booked');
  // roll-ups: YTD is January to August, full year is all twelve months, the company P&L is the sum of the entities
  const months = ['jan26', 'feb26', 'mar26', 'apr26', 'may26', 'jun26', 'jul26', 'aug26', 'sep26', 'oct26', 'nov26', 'dec26'];
  const rev = months.map(p => num('model', { subsidiary: 'us', department: 'company', line: 'revenue', period: p }));
  assert.ok(Math.abs(num('fy', { subsidiary: 'us', department: 'company', line: 'revenue', version: 'ytd_actual' }) - rev.slice(0, 8).reduce((a, b) => a + b, 0)) < 1e-6);
  assert.ok(Math.abs(num('fy', { subsidiary: 'us', department: 'company', line: 'revenue', version: 'fy_outlook' }) - rev.reduce((a, b) => a + b, 0)) < 1e-6);
  const budget = num('fy', { subsidiary: 'us', department: 'company', line: 'revenue', version: 'fy_budget' });
  assert.ok(Math.abs(num('fy', { subsidiary: 'us', department: 'company', line: 'revenue', version: 'fy_variance_pct' }) - (rev.reduce((a, b) => a + b, 0) - budget) / Math.abs(budget)) < 1e-9);
  const usRev = num('pnl', { subsidiary: 'us', line: 'revenue', period: 'mar26' }), ukRev = num('pnl', { subsidiary: 'uk', line: 'revenue', period: 'mar26' });
  assert.ok(Math.abs(num('pnl_company', { line: 'revenue', period: 'mar26' }) - (usRev + ukRev)) < 1e-6);
  const gp = num('pnl_company', { line: 'gross_profit', period: 'mar26' }), opex = num('pnl_company', { line: 'total_opex', period: 'mar26' });
  assert.ok(Math.abs(num('pnl_company', { line: 'ebitda', period: 'mar26' }) - (gp + opex)) < 1e-6);
  assert.ok(num('fy_summary', { line: 'heads', version: 'fy_outlook' }) > num('fy_summary', { line: 'heads', version: 'ytd_actual' }), 'the plan hires');
});

test('scenarios: one rule set, three cases, history shared', () => {
  const { num } = build('scenarios');
  assert.ok(Math.abs(num('income_statement', { scenario: 'base', line: 'revenue', period: 'fy2026' }) - 5131 * 1.9) < 1e-6);
  assert.ok(Math.abs(num('income_statement', { scenario: 'bear', line: 'revenue', period: 'fy2026' }) - 5131 * 1.4) < 1e-6);
  assert.equal(num('income_statement', { scenario: 'bull', line: 'revenue', period: 'fy2025' }), 5131);
  assert.ok(num('sensitivity', { scenario: 'bull', line: 'revenue_fy2028' }) > num('sensitivity', { scenario: 'bear', line: 'revenue_fy2028' }));
});

test('every example exports to a workbook without value-only cells', () => {
  for (const name of ['dcf', 'comparables', 'precedents', 'salesops', 'budget-vs-actual', 'ledger-to-model', 'scenarios', 'coreweave', 'intc-ceos', 'trade-desk']) {
    const f = new FiniDB();
    const r = applyDocument(f, load(name));
    const x = exportWorkbook(f.db, r.model);
    assert.ok(x.formulas > 0, `${name}: no formulas`);
    assert.equal(x.values, 0, `${name}: ${x.notes.join(' | ')}`);
  }
});
