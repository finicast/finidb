import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB } from '../src/index.js';

function build() {
  const f = new FiniDB();
  f.createModel('nvda');
  f.createPeriods('nvda', 'periods', { start: '2024-01', count: 6, grain: 'year', histUntil: '2026-12-31' }); // fy2024..fy2029; hist through fy2026
  f.createTable('nvda', 'is_lines', [{ id: 'name' }, { id: 'category' }], {
    rows: [
      { id: 'revenue', name: 'Revenue', category: 'flow' }, { id: 'cogs', name: 'COGS', category: 'flow' },
      { id: 'gross_profit', name: 'Gross Profit', category: 'flow' }, { id: 'rnd', name: 'R&D', category: 'opex' },
      { id: 'sga', name: 'SG&A', category: 'opex' }, { id: 'opex', name: 'Opex', category: 'flow' },
      { id: 'ebit', name: 'EBIT', category: 'flow' }, { id: 'tax', name: 'Tax', category: 'flow' },
      { id: 'net_income', name: 'Net Income', category: 'flow' }, { id: 'gross_margin', name: 'Gross Margin', category: 'ratio' },
      { id: 'cum_ni', name: 'Cumulative NI', category: 'flow' },
    ],
  });
  f.createTable('nvda', 'financials', [{ id: 'account' }, { id: 'period', ref: 'periods' }, { id: 'amount', type: 'number' }], {
    rows: [
      { id: '1', account: 'revenue', period: 'fy2024', amount: 60922 }, { id: '2', account: 'cogs', period: 'fy2024', amount: 16621 },
      { id: '3', account: 'rnd', period: 'fy2024', amount: 8675 }, { id: '4', account: 'sga', period: 'fy2024', amount: 2654 },
      { id: '5', account: 'revenue', period: 'fy2025', amount: 130497 }, { id: '6', account: 'cogs', period: 'fy2025', amount: 32639 },
      { id: '7', account: 'rnd', period: 'fy2025', amount: 12914 }, { id: '8', account: 'sga', period: 'fy2025', amount: 3491 },
      { id: '9', account: 'revenue', period: 'fy2026', amount: 180000 }, { id: '10', account: 'cogs', period: 'fy2026', amount: 45000 },
      { id: '11', account: 'rnd', period: 'fy2026', amount: 16000 }, { id: '12', account: 'sga', period: 'fy2026', amount: 4000 },
      { id: '13', account: 'revenue', period: 'fy2025', amount: 3 }, // a second revenue row in fy2025 to prove aggregation
    ],
  });
  f.createTable('nvda', 'drivers', [{ id: 'name' }], { rows: [{ id: 'revenue_growth' }, { id: 'cogs_pct' }, { id: 'opex_growth' }, { id: 'tax_rate' }] });
  f.createPivot('nvda', 'assumptions', { dims: [{ id: 'driver', table: 'drivers' }, { id: 'period', table: 'periods' }], lineDim: 'driver', timeDim: 'period' });
  for (const p of ['fy2027', 'fy2028', 'fy2029']) {
    f.setValue('nvda', 'assumptions', { driver: 'revenue_growth', period: p }, 0.4);
    f.setValue('nvda', 'assumptions', { driver: 'cogs_pct', period: p }, 0.25);
    f.setValue('nvda', 'assumptions', { driver: 'opex_growth', period: p }, 0.1);
    f.setValue('nvda', 'assumptions', { driver: 'tax_rate', period: p }, 0.15);
  }
  f.createPivot('nvda', 'income_statement', { dims: [{ id: 'line', table: 'is_lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period', measures: [{ id: 'value' }] });
  f.setRules('nvda', 'income_statement', `
    revenue[frame=hist]      = SUM(financials.amount[account=revenue])
    cogs[frame=hist]         = SUM(financials.amount[account=cogs])
    rnd[frame=hist]          = SUM(financials.amount[account=rnd])
    sga[frame=hist]          = SUM(financials.amount[account=sga])
    revenue[frame=fcst]      = PREV(revenue) * (1 + assumptions.revenue_growth)
    cogs[frame=fcst]         = revenue * assumptions.cogs_pct
    rnd[frame=fcst]          = PREV(rnd) * (1 + assumptions.opex_growth)
    sga[frame=fcst]          = PREV(sga) * (1 + assumptions.opex_growth)
    gross_profit             = revenue - cogs
    opex                     = SUM(value[line.category = opex])
    ebit                     = gross_profit - opex
    tax                      = IF(ebit > 0, ebit * assumptions.tax_rate, 0)
    net_income               = ebit - tax
    gross_margin             = gross_profit / revenue
    cum_ni                   = CUMSUM(net_income)
  `);
  return f;
}

test('NVDA income statement computes hist from the ledger and fcst by recurrence', () => {
  const f = build();
  const g = (line: string, period: string) => f.get('nvda', 'income_statement', { line, period }) as number;
  assert.equal(g('revenue', 'fy2024'), 60922);
  assert.equal(g('revenue', 'fy2025'), 130500);            // 130497 + 3
  assert.equal(g('gross_profit', 'fy2024'), 60922 - 16621);
  assert.equal(g('opex', 'fy2024'), 8675 + 2654);          // attribute-set aggregate
  assert.equal(g('ebit', 'fy2024'), 60922 - 16621 - 8675 - 2654);
  assert.ok(Math.abs(g('revenue', 'fy2027') - 180000 * 1.4) < 1e-6);
  assert.ok(Math.abs(g('revenue', 'fy2029') - 180000 * 1.4 ** 3) < 1e-6);
  assert.ok(Math.abs(g('cogs', 'fy2027') - 180000 * 1.4 * 0.25) < 1e-6);
  assert.ok(Math.abs(g('gross_margin', 'fy2027') - 0.75) < 1e-9);
  // cumulative: sum of net income from first period to this
  let cum = 0;
  for (const p of ['fy2024', 'fy2025', 'fy2026', 'fy2027']) { cum += g('net_income', p); assert.ok(Math.abs(g('cum_ni', p) - cum) < 1e-6, p); }
});

test('an input overrides a rule and a change propagates', () => {
  const f = build();
  const g = (line: string, period: string) => f.get('nvda', 'income_statement', { line, period }) as number;
  const before = g('revenue', 'fy2029');
  f.setValue('nvda', 'assumptions', { driver: 'revenue_growth', period: 'fy2027' }, 0.5);
  assert.ok(Math.abs(g('revenue', 'fy2027') - 180000 * 1.5) < 1e-6);
  assert.ok(g('revenue', 'fy2029') > before);
  f.setValue('nvda', 'income_statement', { line: 'revenue', period: 'fy2027' }, 1000);
  assert.equal(g('revenue', 'fy2027'), 1000);
  assert.ok(Math.abs(g('revenue', 'fy2028') - 1400) < 1e-6);
  // moving the hist/fcst boundary changes which rule governs fy2026
  f.setCell('nvda', 'periods', 'fy2026', 'frame', 'fcst');
  assert.ok(Math.abs(g('revenue', 'fy2026') - 130500 * 1.4) < 1e-6 || g('revenue', 'fy2026') === 130500 * 1 + 0); // growth for fy2026 is blank -> 0
});

test('renders markdown', () => {
  const f = build();
  const md = f.query('nvda', { table: 'income_statement', rows: ['line'], cols: ['period'], title: 'NVDA — Income Statement ($M)', formats: { gross_margin: 'percent' } }) as string;
  assert.match(md, /\| Revenue/);
  assert.match(md, /FY2029/);
  assert.match(md, /75\.0%/);
  console.log('\n' + md + '\n');
});

test('compile errors are actionable', () => {
  const f = build();
  assert.throws(() => f.setRules('nvda', 'income_statement', 'ebit = gross_profit - opexx', { replace: false }), /UNKNOWN_NAME|opexx/);
  assert.throws(() => f.setRules('nvda', 'income_statement', 'ebit = financials.amount', { replace: false }), /refers to .* rows|SET_IN_SCALAR/);
});
