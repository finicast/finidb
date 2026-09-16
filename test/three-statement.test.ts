import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB, isError } from '../src/index.js';

/**
 * Three statements in three pivots that reference each other across periods:
 *   IS.interest(t)  = BS.debt(t-1) * rate          (income statement reads last year's balance sheet)
 *   CF.ocf(t)       = IS.net_income(t) + IS.da(t)   (cash flow reads this year's income statement)
 *   BS.cash(t)      = BS.cash(t-1) + CF.fcf(t)      (balance sheet reads this year's cash flow)
 *   BS.debt(t)      = BS.debt(t-1) + CF.borrow(t)
 * No cell depends on itself, but every column depends on every other column. The engine must
 * agree with the cell-by-cell reference evaluator on every cell.
 */
function build(engine: 'reference' | 'incremental') {
  const f = new FiniDB({ engine });
  f.createModel('m');
  f.createPeriods('m', 'periods', { start: '2025-01', count: 6, grain: 'year', histUntil: '2025-12-31' });
  f.createTable('m', 'is_lines', [], { rows: [{ id: 'revenue' }, { id: 'ebitda' }, { id: 'da' }, { id: 'interest' }, { id: 'net_income' }] });
  f.createTable('m', 'cf_lines', [], { rows: [{ id: 'ocf' }, { id: 'capex' }, { id: 'fcf' }, { id: 'borrow' }] });
  f.createTable('m', 'bs_lines', [], { rows: [{ id: 'cash' }, { id: 'debt' }, { id: 'ppe' }] });
  f.createPivot('m', 'is', { dims: [{ id: 'line', table: 'is_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.createPivot('m', 'cf', { dims: [{ id: 'line', table: 'cf_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.createPivot('m', 'bs', { dims: [{ id: 'line', table: 'bs_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.setValue('m', 'is', { line: 'revenue', period: 'fy2025' }, 1000);
  f.setValue('m', 'is', { line: 'ebitda', period: 'fy2025' }, 300);
  f.setValue('m', 'is', { line: 'da', period: 'fy2025' }, 100);
  f.setValue('m', 'is', { line: 'interest', period: 'fy2025' }, 40);
  f.setValue('m', 'cf', { line: 'ocf', period: 'fy2025' }, 260);
  f.setValue('m', 'cf', { line: 'capex', period: 'fy2025' }, -500);
  f.setValue('m', 'cf', { line: 'borrow', period: 'fy2025' }, 300);
  f.setValue('m', 'bs', { line: 'cash', period: 'fy2025' }, 100);
  f.setValue('m', 'bs', { line: 'debt', period: 'fy2025' }, 800);
  f.setValue('m', 'bs', { line: 'ppe', period: 'fy2025' }, 2000);
  f.setRules('m', 'is', `
    revenue[frame=fcst]  = PREV(revenue) * 1.5
    ebitda[frame=fcst]   = revenue * 0.35
    da[frame=fcst]       = bs.ppe[period-1] * 0.1
    interest[frame=fcst] = bs.debt[period-1] * 0.08
    net_income           = ebitda - da - interest
  `);
  f.setRules('m', 'cf', `
    ocf[frame=fcst]    = is.net_income + is.da
    capex[frame=fcst]  = -is.revenue * 0.6
    borrow[frame=fcst] = -(ocf + capex) * 0.9
    fcf                = ocf + capex
  `);
  f.setRules('m', 'bs', `
    cash[frame=fcst] = PREV(cash) + cf.fcf + cf.borrow
    debt[frame=fcst] = PREV(debt) + cf.borrow
    ppe[frame=fcst]  = PREV(ppe) - cf.capex - is.da
  `);
  return f;
}

test('cross-pivot references with period offsets compute the same in both engines', () => {
  const ref = build('reference'), inc = build('incremental');
  const periods = ['fy2025', 'fy2026', 'fy2027', 'fy2028', 'fy2029', 'fy2030'];
  const tables: [string, string[]][] = [['is', ['revenue', 'ebitda', 'da', 'interest', 'net_income']], ['cf', ['ocf', 'capex', 'fcf', 'borrow']], ['bs', ['cash', 'debt', 'ppe']]];
  // read in the order an agent would: income statement first, so the engine sees the nested dependency chain
  for (const [t, lines] of tables) for (const line of lines) for (const period of periods) {
    const a = ref.get('m', t, { line, period }), b = inc.get('m', t, { line, period });
    assert.ok(!isError(a), `${t}.${line}@${period} reference error ${JSON.stringify(a)}`);
    assert.ok(!isError(b), `${t}.${line}@${period} incremental error ${JSON.stringify(b)}`);
    assert.ok(Math.abs((a as number) - (b as number)) < 1e-6, `${t}.${line}@${period}: incremental ${b} vs reference ${a}`);
  }
  // sanity: the recurrence actually threads through the balance sheet
  assert.ok(Math.abs((ref.get('m', 'is', { line: 'interest', period: 'fy2027' }) as number) - (ref.get('m', 'bs', { line: 'debt', period: 'fy2026' }) as number) * 0.08) < 1e-6);
  // an edit propagates identically
  for (const f of [ref, inc]) f.setValue('m', 'bs', { line: 'debt', period: 'fy2025' }, 900);
  for (const [t, lines] of tables) for (const line of lines) for (const period of periods) {
    const a = ref.get('m', t, { line, period }), b = inc.get('m', t, { line, period });
    assert.ok(Math.abs((a as number) - (b as number)) < 1e-6, `after edit ${t}.${line}@${period}: incremental ${b} vs reference ${a}`);
  }
});
