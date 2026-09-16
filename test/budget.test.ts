import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB } from '../src/index.js';

/** Scenario S2 (doc 02): a ledger CSV becomes a budget with actual/plan by cost centre and period. */
test('ledger → budget: PERIOD(date), distinct-values dimension, hist/fcst plan', () => {
  for (const engine of ['reference', 'incremental'] as const) {
    const f = new FiniDB({ engine });
    f.createModel('b');
    f.createPeriods('b', 'periods', { start: '2026-01', count: 6, grain: 'month', histUntil: '2026-03-31' });
    f.createTable('b', 'ledger', [{ id: 'date', type: 'date' }, { id: 'cost_center' }, { id: 'amount', type: 'number' }, { id: 'period', ref: 'periods', computed: true }], {
      rows: [
        { id: '1', date: '2026-01-15', cost_center: 'eng', amount: 100 }, { id: '2', date: '2026-02-03', cost_center: 'eng', amount: 50 },
        { id: '3', date: '2026-02-28', cost_center: 'sales', amount: 70 }, { id: '4', date: '2026-03-10', cost_center: 'eng', amount: 80 },
        { id: '5', date: '2027-01-01', cost_center: 'eng', amount: 1 },   // outside the periods table → blank period, excluded
      ],
    });
    f.setRules('b', 'ledger', 'period = PERIOD(date)');
    assert.equal(f.getField('b', 'ledger', '1', 'period'), 'jan26');
    assert.equal(f.getField('b', 'ledger', '3', 'period'), 'feb26');
    assert.equal(f.getField('b', 'ledger', '5', 'period'), null);
    f.createDistinctTable('b', 'cost_centers', 'ledger', 'cost_center');
    f.createTable('b', 'lines', [], { rows: [{ id: 'actual' }, { id: 'plan' }, { id: 'variance' }] });
    f.createPivot('b', 'budget', { dims: [{ id: 'cc', table: 'cost_centers' }, { id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
    f.setRules('b', 'budget', `
      actual            = SUM(ledger.amount[cost_center=@cc])
      plan[frame=hist]  = actual
      plan[frame=fcst]  = PREV(plan) * 1.10
      variance          = actual - plan
    `);
    const g = (cc: string, line: string, period: string) => f.get('b', 'budget', { cc, line, period }) as number;
    assert.equal(g('eng', 'actual', 'jan26'), 100);
    assert.equal(g('eng', 'actual', 'feb26'), 50);
    assert.equal(g('sales', 'actual', 'feb26'), 70);
    assert.equal(g('eng', 'plan', 'mar26'), 80);
    assert.ok(Math.abs(g('eng', 'plan', 'apr26') - 88) < 1e-9);
    assert.ok(Math.abs(g('eng', 'plan', 'jun26') - 80 * 1.1 ** 3) < 1e-9);
    // an edit in the ledger moves a row between periods
    f.setCell('b', 'ledger', '4', 'date', '2026-02-11');
    assert.equal(g('eng', 'actual', 'mar26'), 0);
    assert.equal(g('eng', 'actual', 'feb26'), 130);
    assert.ok(Math.abs(g('eng', 'plan', 'apr26') - 0) < 1e-9);
  }
});
