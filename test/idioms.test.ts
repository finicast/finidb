import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB } from '../src/index.js';

test('pivot-to-pivot marginal rollup, member masks, cross-pivot reads', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createPeriods('m', 'periods', { start: '2026-01', count: 3, grain: 'month' });
  f.createTable('m', 'geos', [], { rows: [{ id: 'us' }, { id: 'emea' }] });
  f.createTable('m', 'customers', [{ id: 'geo', ref: 'geos' }], { rows: [{ id: 'c1', geo: 'us' }, { id: 'c2', geo: 'us' }, { id: 'c3', geo: 'emea' }] });
  f.createTable('m', 'cust_lines', [], { rows: [{ id: 'arr' }, { id: 'arr_change' }, { id: 'prior_arr' }] });
  f.createPivot('m', 'customer_data', { dims: [{ id: 'customer', table: 'customers' }, { id: 'line', table: 'cust_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  const arr: Record<string, number[]> = { c1: [100, 120, 130], c2: [50, 50, 0], c3: [10, 20, 30] };
  const per = ['jan26', 'feb26', 'mar26'];
  for (const c in arr) arr[c].forEach((v, i) => f.setValue('m', 'customer_data', { customer: c, line: 'arr', period: per[i] }, v));
  f.setRules('m', 'customer_data', `
    prior_arr  = PREV(arr)
    arr_change = arr - arr[period-1]
  `);
  assert.equal(f.get('m', 'customer_data', { customer: 'c1', line: 'arr_change', period: 'feb26' }), 20);
  assert.equal(f.get('m', 'customer_data', { customer: 'c1', line: 'arr_change', period: 'jan26' }), 100); // out of range -> blank -> 0
  assert.equal(f.get('m', 'customer_data', { customer: 'c1', line: 'prior_arr', period: 'jan26' }), null);

  // summary pivot: geo x line x period = marginal sum over customers, with geo matched through customers.geo
  f.createTable('m', 'sum_lines', [], { rows: [{ id: 'ending_arr' }, { id: 'total_change' }, { id: 'us_share' }] });
  f.createPivot('m', 'arr_summary', { dims: [{ id: 'geo', table: 'geos' }, { id: 'line', table: 'sum_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.setRules('m', 'arr_summary', `
    ending_arr   = SUM(customer_data.arr[customer.geo = @geo])
    total_change = SUM(customer_data.arr_change[customer.geo = @geo])
    us_share     = ending_arr / SUM(customer_data.arr)
  `);
  assert.equal(f.get('m', 'arr_summary', { geo: 'us', line: 'ending_arr', period: 'feb26' }), 170);
  assert.equal(f.get('m', 'arr_summary', { geo: 'emea', line: 'ending_arr', period: 'mar26' }), 30);
  assert.equal(f.get('m', 'arr_summary', { geo: 'us', line: 'total_change', period: 'feb26' }), 20);
  assert.ok(Math.abs((f.get('m', 'arr_summary', { geo: 'us', line: 'us_share', period: 'jan26' }) as number) - 150 / 160) < 1e-9);
});

test('subtotal via != mask and a line-item range', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createTable('m', 'tranches', [], { rows: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 'total' }] });
  f.createTable('m', 'lines', [], { rows: [{ id: 'comm' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'sum_ab' }] });
  f.createPivot('m', 'comm', { dims: [{ id: 'tranche', table: 'tranches' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
  f.setValue('m', 'comm', { tranche: 't1', line: 'comm' }, 10);
  f.setValue('m', 'comm', { tranche: 't2', line: 'comm' }, 20);
  f.setValue('m', 'comm', { tranche: 't3', line: 'comm' }, 30);
  for (const t of ['t1', 't2', 't3', 'total']) { f.setValue('m', 'comm', { tranche: t, line: 'a' }, 1); f.setValue('m', 'comm', { tranche: t, line: 'b' }, 2); f.setValue('m', 'comm', { tranche: t, line: 'c' }, 4); }
  f.setRules('m', 'comm', `
    comm[tranche=total] = SUM(comm[tranche != total])
    sum_ab              = SUM(value[line = a..b])
  `);
  assert.equal(f.get('m', 'comm', { tranche: 'total', line: 'comm' }), 60);
  assert.equal(f.get('m', 'comm', { tranche: 't1', line: 'sum_ab' }), 3);
});

test('hierarchy rollup through an attribute and a dynamic pin', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createTable('m', 'regions', [{ id: 'parent', ref: 'regions' }, { id: 'pct_of_parent', type: 'number' }], {
    rows: [{ id: 'world', parent: null, pct_of_parent: 1 }, { id: 'na', parent: 'world', pct_of_parent: 0.6 }, { id: 'eu', parent: 'world', pct_of_parent: 0.4 }, { id: 'us', parent: 'na', pct_of_parent: 0.9 }, { id: 'ca', parent: 'na', pct_of_parent: 0.1 }],
  });
  f.createTable('m', 'lines', [], { rows: [{ id: 'goal' }, { id: 'sum_of_subs' }, { id: 'topdown' }] });
  f.createPivot('m', 'quota', { dims: [{ id: 'region', table: 'regions' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
  f.setValue('m', 'quota', { region: 'us', line: 'goal' }, 90);
  f.setValue('m', 'quota', { region: 'ca', line: 'goal' }, 10);
  f.setValue('m', 'quota', { region: 'eu', line: 'goal' }, 50);
  f.setValue('m', 'quota', { region: 'world', line: 'topdown' }, 1000);
  f.setRules('m', 'quota', `
    sum_of_subs = SUM(goal[region.parent = @region])
    topdown     = topdown[region = @region.parent] * region.pct_of_parent
  `);
  assert.equal(f.get('m', 'quota', { region: 'na', line: 'sum_of_subs' }), 100);
  assert.equal(f.get('m', 'quota', { region: 'world', line: 'sum_of_subs' }), 50); // na has no goal input (blank); eu has 50
  assert.ok(Math.abs((f.get('m', 'quota', { region: 'us', line: 'topdown' }) as number) - 1000 * 0.6 * 0.9) < 1e-9);
});

test('tabular computed fields: paths through refs, row-1 running balance, cross-pivot read with @field', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createTable('m', 'accounts', [{ id: 'region' }, { id: 'employees', type: 'number' }], { rows: [{ id: 'acme', region: 'west', employees: 100 }, { id: 'globex', region: 'east', employees: 20 }] });
  f.createTable('m', 'ledger', [{ id: 'account', ref: 'accounts' }, { id: 'amount', type: 'number' }, { id: 'region', computed: true }, { id: 'balance', type: 'number', computed: true }, { id: 'email', computed: true }], {
    rows: [{ id: '1', account: 'acme', amount: 10 }, { id: '2', account: 'globex', amount: 5 }, { id: '3', account: 'acme', amount: -3 }],
  });
  f.setRules('m', 'ledger', `
    region  = account.region
    balance = balance[row-1] + amount
    email   = "chase+" & SUBSTITUTE(id, " ", "") & "@finicast.com"
  `);
  assert.equal(f.getField('m', 'ledger', '2', 'region'), 'east');
  assert.equal(f.getField('m', 'ledger', '3', 'balance'), 12);
  assert.equal(f.getField('m', 'ledger', '1', 'email'), 'chase+1@finicast.com');

  // count of ledger rows per account via a pivot, then read back into the table with @account
  f.createTable('m', 'metrics', [], { rows: [{ id: 'n' }, { id: 'total' }] });
  f.createPivot('m', 'acct', { dims: [{ id: 'account', table: 'accounts' }, { id: 'metric', table: 'metrics' }], lineDim: 'metric' });
  f.setRules('m', 'acct', `
    n     = COUNT(ledger.id)
    total = SUM(ledger.amount) + 0 * account.employees
  `);
  assert.equal(f.get('m', 'acct', { account: 'acme', metric: 'n' }), 2);
  assert.equal(f.get('m', 'acct', { account: 'acme', metric: 'total' }), 7);
  f.addField(f.model('m').table('ledger') as any, { id: 'acct_total', type: 'number', computed: true });
  f.setRules('m', 'ledger', 'acct_total = acct.total[account=@account]', { replace: false });
  assert.equal(f.getField('m', 'ledger', '3', 'acct_total'), 7);
});

test('ambiguous group keys fail with a fix', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createTable('m', 'reps', [], { rows: [{ id: 'r1' }, { id: 'r2' }] });
  f.createTable('m', 'deals', [{ id: 'owner', ref: 'reps' }, { id: 'closer', ref: 'reps' }, { id: 'acv', type: 'number' }], { rows: [{ id: 'd1', owner: 'r1', closer: 'r2', acv: 100 }] });
  f.createTable('m', 'lines', [], { rows: [{ id: 'bookings' }] });
  f.createPivot('m', 'by_rep', { dims: [{ id: 'rep', table: 'reps' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
  assert.throws(() => f.setRules('m', 'by_rep', 'bookings = SUM(deals.acv)'), /AMBIGUOUS_GROUP_KEY/);
  f.setRules('m', 'by_rep', 'bookings = SUM(deals.acv[owner=@rep])');
  assert.equal(f.get('m', 'by_rep', { rep: 'r1', line: 'bookings' }), 100);
  assert.equal(f.get('m', 'by_rep', { rep: 'r2', line: 'bookings' }), 0);
});
