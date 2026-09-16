import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, parseRule, parseRules } from '../src/lang/parser.js';

test('parses arithmetic with precedence', () => {
  const e = parseExpression('1 + 2 * 3 ^ 2');
  assert.equal(e.k, 'bin');
  if (e.k === 'bin') { assert.equal(e.op, '+'); assert.equal(e.r.k, 'bin'); }
});

test('parses percent literal and comments', () => {
  const e = parseExpression('/* growth */ 12% + 1 // trailing');
  assert.deepEqual(e, { k: 'bin', op: '+', l: { k: 'num', v: 0.12 }, r: { k: 'num', v: 1 } });
});

test('parses references with selectors', () => {
  const e = parseExpression('Revenue[period-1]');
  assert.equal(e.k, 'ref');
  if (e.k === 'ref') { assert.deepEqual(e.parts, ['Revenue']); assert.deepEqual(e.selectors, [{ k: 'offset', dim: 'period', by: -1 }]); }
  const f = parseExpression("comm_calc.value[tranche=total, line='Comm Dol']");
  if (f.k === 'ref') { assert.deepEqual(f.parts, ['comm_calc', 'value']); assert.equal(f.selectors.length, 2); }
  const g = parseExpression('SUM(value[line=bookings_goal, region.parent=@region])');
  assert.equal(g.k, 'call');
  if (g.k === 'call' && g.args[0].k === 'ref') assert.deepEqual(g.args[0].selectors[1], { k: 'corr', path: ['region', 'parent'], right: ['region'] });
});

test('parses ranges, in, attribute tests, dynamic pins and paths', () => {
  const a = parseExpression('SUM(x[period = first..this])');
  if (a.k === 'call' && a.args[0].k === 'ref') assert.equal(a.args[0].selectors[0].k, 'range');
  const b = parseExpression('AVG(x[period = this-3 .. this-1])');
  if (b.k === 'call' && b.args[0].k === 'ref' && b.args[0].selectors[0].k === 'range') assert.deepEqual(b.args[0].selectors[0].from, { k: 'kw', v: 'this', by: -3 });
  const c = parseExpression('value[line in (revenue, "other revenue"), period.year >= 2027]');
  if (c.k === 'ref') { assert.equal(c.selectors[0].k, 'in'); assert.equal(c.selectors[1].k, 'cmp'); }
  const d = parseExpression('value[region=@region.parent] * pct_of_parent');
  if (d.k === 'bin' && d.l.k === 'ref') assert.deepEqual(d.l.selectors[0], { k: 'corr', path: ['region'], right: ['region', 'parent'] });
  const e = parseExpression('activity_type.score');
  if (e.k === 'ref') assert.deepEqual(e.parts, ['activity_type', 'score']);
  const f = parseExpression('activities.score[activity_type != score].foo');
  if (f.k === 'ref') { assert.deepEqual(f.parts, ['activities', 'score']); assert.deepEqual(f.path, ['foo']); }
});

test('parses rules', () => {
  const r = parseRule('Revenue[frame=fcst] = PREV(Revenue) * (1 + assumptions.revenue_growth)');
  assert.deepEqual(r.target, ['Revenue']);
  assert.equal(r.when.length, 1);
  assert.equal(r.formulaText, 'PREV(Revenue) * (1 + assumptions.revenue_growth)');
  const rs = parseRules(`
    GrossProfit = Revenue - COGS   // margin
    points = SUM(activities.score)
  `);
  assert.equal(rs.length, 2);
});

test('parses the corpus idioms from doc 04 §8', () => {
  const idioms = [
    'ARR[period-1]', 'PREV(ARR)', 'ARR[period-12]', 'value[frame=proposed]',
    'value[segment=enterprise] + value[segment=mid_market]',
    'value[region=@region.parent] * pct_of_parent',
    'activity_type.points', 'x[row-1]', 'x[forecast_period+1]',
    'SUM(bookings.acv)', 'account.region',
    'account_territories.value[account=@account, period=@period]',
    'SUM(customer_data.value[line=new])', 'SUM(value[activity_type != score])',
    'SUM(value[tranche != total])', 'SUM(value[line=bookings_goal, region.parent=@region])',
    'COUNT(activities.id) * activity_type.points',
    'comm_calc.value[tranche=total, line=comm_dol]',
    'IF(line.agg = "closing", LAST(value[period.quarter=@period, period.kind=month]), SUM(value[period.quarter=@period, period.kind=month]))',
    'CONCAT(account_regions.value, "-", account_industries.value, "-", account_sizes.value)',
    '"chase+" & SUBSTITUTE(id, " ", "") & "@finicast.com"',
    'IFERROR((this_month - prior_month) / prior_month, BLANK)',
    "IF( /*New*/ AND(arr_change > 0, ARR[period-1] <> 0), \"New\", IF( /*Expansion*/ AND(arr_change > 0, ARR[period-1] = 0), \"Expansion\", \"No change\"))",
    "'Bookings Goal' - 'Bookings - Ramped'",
    'SUM(value[line = sales..ga])', 'SUM(value[line.category = opex])', 'CUMSUM(NetIncome)', 'TRAILING(Revenue, 3, AVG)',
  ];
  for (const s of idioms) assert.doesNotThrow(() => parseExpression(s), s);
});
