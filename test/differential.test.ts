/**
 * Differential test (doc 05 §12): the incremental engine must agree with the reference evaluator
 * cell for cell after every edit of a random edit sequence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB, Pivot, Table, isError } from '../src/index.js';

type Build = (f: FiniDB) => void;

function buildModel(f: FiniDB, seed: number) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  f.createModel('m');
  f.createPeriods('m', 'periods', { start: '2026-01', count: 6, grain: 'month', histUntil: '2026-03-31' });
  f.createTable('m', 'regions', [{ id: 'parent', ref: 'regions' }, { id: 'weight', type: 'number' }], {
    rows: [{ id: 'world', parent: null, weight: 1 }, { id: 'na', parent: 'world', weight: 0.6 }, { id: 'eu', parent: 'world', weight: 0.4 }, { id: 'us', parent: 'na', weight: 0.8 }, { id: 'ca', parent: 'na', weight: 0.2 }],
  });
  f.createTable('m', 'types', [{ id: 'score', type: 'number' }], { rows: [{ id: 'call', score: 1 }, { id: 'email', score: 0.5 }, { id: 'demo', score: 8 }] });
  f.createTable('m', 'reps', [{ id: 'region', ref: 'regions' }], { rows: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, region: ['us', 'ca', 'eu'][i % 3] })) });
  const per = ['jan26', 'feb26', 'mar26', 'apr26', 'may26', 'jun26'];
  const acts = Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, rep: `r${(rnd() * 8) | 0}`, type: ['call', 'email', 'demo'][(rnd() * 3) | 0], period: per[(rnd() * 6) | 0], amount: Math.round(rnd() * 100) }));
  f.createTable('m', 'acts', [{ id: 'rep', ref: 'reps' }, { id: 'type', ref: 'types' }, { id: 'period', ref: 'periods' }, { id: 'amount', type: 'number' }, { id: 'score', type: 'number', computed: true }, { id: 'weighted', type: 'number', computed: true }, { id: 'running', type: 'number', computed: true }], { rows: acts });
  f.setRules('m', 'acts', `
    score    = type.score
    weighted = score * rep.region.weight
    running  = running[row-1] + amount
  `);
  f.createTable('m', 'lines', [{ id: 'kind' }], { rows: [{ id: 'points', kind: 'flow' }, { id: 'amount', kind: 'flow' }, { id: 'per_point', kind: 'ratio' }, { id: 'growth', kind: 'ratio' }, { id: 'fcst', kind: 'flow' }, { id: 'cum', kind: 'flow' }, { id: 'subs', kind: 'flow' }, { id: 'share', kind: 'ratio' }] });
  f.createPivot('m', 'scores', { dims: [{ id: 'region', table: 'regions' }, { id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
  f.setRules('m', 'scores', `
    points              = SUM(acts.score)
    amount              = SUM(acts.amount[type != email])
    per_point           = IFERROR(amount / points, 0)
    growth              = 0.1
    fcst[frame=hist]    = amount
    fcst[frame=fcst]    = PREV(fcst) * (1 + growth)
    cum                 = CUMSUM(amount)
    subs                = SUM(amount[region.parent = @region]) + amount
    share               = IFERROR(amount / SUM(amount[region=all]), 0)
  `);
  return { rnd, per, acts };
}

function snapshot(f: FiniDB): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const m = f.model('m');
  for (const t of m.tables.values()) {
    if (t.kind === 'pivot') {
      const p = t as Pivot;
      const radices = p.radices();
      const total = p.totalCells();
      for (const meas of p.measures) for (let a = 0; a < total; a++) {
        const coord = new Int32Array(radices.length); let rem = a;
        for (let i = radices.length - 1; i >= 0; i--) { coord[i] = rem % radices[i]; rem = Math.floor(rem / radices[i]); }
        const v = f.evaluator.cell(p, meas, coord);
        out[`${p.id}.${meas.id}@${p.tupleKey(coord)}`] = isError(v) ? `#${v.error}` : v;
      }
    } else {
      const tb = t as Table;
      for (const fld of tb.fields) if (fld.computed) for (let r = 0; r < tb.rowCount; r++) { const v = f.evaluator.field(tb, fld, r); out[`${tb.id}.${fld.id}@${r}`] = isError(v) ? `#${v.error}` : v; }
    }
  }
  return out;
}

function assertSame(a: Record<string, unknown>, b: Record<string, unknown>, step: string) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number') { if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) assert.fail(`${step}: ${k} incremental=${y} reference=${x}`); }
    else if (x !== y && !((x === null || x === 0) && (y === null || y === 0))) assert.fail(`${step}: ${k} incremental=${JSON.stringify(y)} reference=${JSON.stringify(x)}`);
  }
}

test('incremental engine agrees with the reference evaluator over random edit sequences', () => {
  for (const seed of Array.from({ length: Number(process.env.DIFF_SEEDS ?? 3) }, (_, i) => i + 1)) {
    const ref = new FiniDB({ engine: 'reference' });
    const inc = new FiniDB({ engine: 'incremental' });
    const { rnd, per } = buildModel(ref, seed);
    buildModel(inc, seed);
    assertSame(snapshot(ref), snapshot(inc), `seed ${seed} initial`);
    const regions = ['world', 'na', 'eu', 'us', 'ca'];
    for (let step = 0; step < Number(process.env.DIFF_STEPS ?? 60); step++) {
      const kind = (rnd() * 7) | 0;
      const draws = [rnd(), rnd()];
      const apply = (f: FiniDB) => {
        const [x, y] = draws;
        switch (kind) {
          case 0: f.setCell('m', 'acts', `a${(x * 300) | 0}`, 'amount', Math.round(y * 100)); break;
          case 1: f.setCell('m', 'acts', `a${(x * 300) | 0}`, 'type', ['call', 'email', 'demo'][(y * 3) | 0]); break;
          case 2: f.setCell('m', 'types', ['call', 'email', 'demo'][(x * 3) | 0], 'score', Math.round(y * 10)); break;
          case 3: f.setCell('m', 'reps', `r${(x * 8) | 0}`, 'region', ['us', 'ca', 'eu'][(y * 3) | 0]); break;
          case 4: f.setValue('m', 'scores', { region: regions[(x * 5) | 0], line: 'growth', period: per[(y * 6) | 0] }, Math.round(y * 50) / 100); break;
          case 5: f.setCell('m', 'periods', per[(x * 6) | 0], 'frame', y < 0.5 ? 'hist' : 'fcst'); break;
          case 6: f.setCell('m', 'regions', regions[(x * 5) | 0], 'weight', Math.round(y * 10) / 10); break;
        }
      };
      apply(ref); apply(inc);
      assertSame(snapshot(ref), snapshot(inc), `seed ${seed} step ${step} kind ${kind}`);
    }
  }
});
