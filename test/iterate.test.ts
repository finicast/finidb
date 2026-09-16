import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB, isError } from '../src/index.js';

/**
 * Same-period circularity, the finance idiom Excel handles with iterative calculation:
 *   interest(t) = rate * (debt(t-1) + debt(t)) / 2          interest on the average balance
 *   borrow(t)   = MAX(0, min_cash - (cash(t-1) + ebitda - interest - capex))   a minimum-cash revolver
 *   debt(t)     = debt(t-1) + borrow(t)
 *   cash(t)     = cash(t-1) + ebitda - interest - capex + borrow
 * borrow → interest → debt → borrow is a cycle inside one period. The closed form when the revolver draws:
 *   borrow = (min_cash - cash0 - ebitda + capex + rate*debt0) / (1 - rate/2)
 */
const RATE = 0.08, MIN_CASH = 500;
const periods = ['fy2025', 'fy2026', 'fy2027', 'fy2028'];
function build(engine: 'reference' | 'incremental', iterate: boolean | { maxIterations?: number; tolerance?: number } = { tolerance: 1e-9 }) {
  const f = new FiniDB({ engine });
  f.createModel('m');
  f.createPeriods('m', 'periods', { start: '2025-01', count: 4, grain: 'year', histUntil: '2025-12-31' });
  f.createTable('m', 'lines', [], { rows: [{ id: 'ebitda' }, { id: 'capex' }, { id: 'interest' }, { id: 'borrow' }, { id: 'debt' }, { id: 'cash' }] });
  f.createPivot('m', 'fin', { dims: [{ id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  if (iterate) f.setIterate('m', iterate);
  f.setValue('m', 'fin', { line: 'debt', period: 'fy2025' }, 1000);
  f.setValue('m', 'fin', { line: 'cash', period: 'fy2025' }, 600);
  const ebitda: Record<string, number> = { fy2026: 300, fy2027: 400, fy2028: 900 }, capex: Record<string, number> = { fy2026: 700, fy2027: 500, fy2028: 200 };
  for (const p of periods.slice(1)) { f.setValue('m', 'fin', { line: 'ebitda', period: p }, ebitda[p]); f.setValue('m', 'fin', { line: 'capex', period: p }, capex[p]); }
  f.setRules('m', 'fin', `
    interest[frame=fcst] = ${RATE} * (PREV(debt) + debt) / 2
    borrow[frame=fcst]   = MAX(0, ${MIN_CASH} - (PREV(cash) + ebitda - interest - capex))
    debt[frame=fcst]     = PREV(debt) + borrow
    cash[frame=fcst]     = PREV(cash) + ebitda - interest - capex + borrow
  `);
  return { f, ebitda, capex };
}
function closedForm(ebitda: Record<string, number>, capex: Record<string, number>) {
  const out: Record<string, { borrow: number; debt: number; cash: number; interest: number }> = {};
  let debt0 = 1000, cash0 = 600;
  for (const p of periods.slice(1)) {
    let borrow = (MIN_CASH - cash0 - ebitda[p] + capex[p] + RATE * debt0) / (1 - RATE / 2);
    if (borrow < 0) borrow = 0;
    const debt = debt0 + borrow, interest = RATE * (debt0 + debt) / 2, cash = cash0 + ebitda[p] - interest - capex[p] + borrow;
    out[p] = { borrow, debt, cash, interest }; debt0 = debt; cash0 = cash;
  }
  return out;
}

for (const engine of ['reference', 'incremental'] as const) {
  test(`${engine}: a minimum-cash revolver with interest on average debt converges to the closed form`, () => {
    const { f, ebitda, capex } = build(engine);
    const want = closedForm(ebitda, capex);
    for (const p of periods.slice(1)) for (const line of ['borrow', 'debt', 'cash', 'interest'] as const) {
      const got = f.get('m', 'fin', { line, period: p });
      assert.ok(!isError(got), `${line}@${p}: ${JSON.stringify(got)}`);
      assert.ok(Math.abs((got as number) - want[p][line]) < 1e-6, `${line}@${p}: got ${got} want ${want[p][line]}`);
    }
    // the revolver draws in fy2026 (cash would fall below the minimum) and not in fy2028
    assert.ok((f.get('m', 'fin', { line: 'borrow', period: 'fy2026' }) as number) > 0);
    assert.equal(f.get('m', 'fin', { line: 'borrow', period: 'fy2028' }), 0);
    assert.ok(Math.abs((f.get('m', 'fin', { line: 'cash', period: 'fy2026' }) as number) - MIN_CASH) < 1e-6, 'cash held at the minimum when the revolver draws');
  });

  test(`${engine}: without the setting the cycle is #CYCLE`, () => {
    const { f } = build(engine, false);
    const v = f.get('m', 'fin', { line: 'borrow', period: 'fy2026' });
    assert.ok(isError(v) && v.error === 'CYCLE', JSON.stringify(v));
  });

  test(`${engine}: a diverging cycle reports #ITER instead of looping forever`, () => {
    const f = new FiniDB({ engine });
    f.createModel('m'); f.setIterate('m', { maxIterations: 50, tolerance: 0.001 });
    f.createTable('m', 'l', [], { rows: [{ id: 'a' }, { id: 'b' }] });
    f.createPivot('m', 'p', { dims: [{ id: 'line', table: 'l' }], lineDim: 'line' });
    f.setRules('m', 'p', 'a = 2 * b + 1\nb = a');
    const v = f.get('m', 'p', { line: 'a' });
    assert.ok(isError(v) && v.error === 'ITER', JSON.stringify(v));
    const w = f.get('m', 'p', { line: 'b' });
    assert.ok(isError(w) && w.error === 'ITER', `b inherits: ${JSON.stringify(w)}`);
  });
}

test('edits propagate through the cycle identically in both engines', () => {
  const a = build('reference'), b = build('incremental');
  const check = (label: string) => {
    for (const p of periods) for (const line of ['ebitda', 'capex', 'interest', 'borrow', 'debt', 'cash']) {
      const x = a.f.get('m', 'fin', { line, period: p }), y = b.f.get('m', 'fin', { line, period: p });
      if (typeof x === 'number' && typeof y === 'number') assert.ok(Math.abs(x - y) < 1e-6, `${label} ${line}@${p}: ${x} vs ${y}`);
      else assert.deepEqual(x, y, `${label} ${line}@${p}`);
    }
  };
  check('initial');
  for (const f of [a.f, b.f]) f.setValue('m', 'fin', { line: 'capex', period: 'fy2026' }, 1500);   // a deeper draw
  check('after capex edit');
  for (const f of [a.f, b.f]) f.setValue('m', 'fin', { line: 'ebitda', period: 'fy2027' }, 2000);  // no draw needed any more
  check('after ebitda edit');
  assert.equal(b.f.get('m', 'fin', { line: 'borrow', period: 'fy2027' }), 0);
  for (const f of [a.f, b.f]) f.setValue('m', 'fin', { line: 'debt', period: 'fy2025' }, 5000);    // opening balance: interest ↑, draw ↑
  check('after opening debt edit');
});

test('the setting survives the oplog and the snapshot', async () => {
  const { createPersistentFiniDB, openDatabase } = await import('../src/index.js');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'finidb-iter-'));
  const f = createPersistentFiniDB(dir);
  f.createModel('m'); f.setIterate('m', { maxIterations: 40, tolerance: 0.01 });
  f.createTable('m', 'l', [], { rows: [{ id: 'a' }, { id: 'b' }] });
  f.createPivot('m', 'p', { dims: [{ id: 'line', table: 'l' }], lineDim: 'line' });
  f.setRules('m', 'p', 'a = 0.5 * b + 10\nb = a');   // converges to a = b = 20
  await f.oplog.close();
  const o = await openDatabase(dir);
  assert.deepEqual(o.f.model('m').iterate, { maxIterations: 40, tolerance: 0.01 });
  assert.ok(Math.abs((o.f.get('m', 'p', { line: 'a' }) as number) - 20) < 0.05);
  await o.close();
});
