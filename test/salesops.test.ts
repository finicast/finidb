import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiniDB } from '../src/index.js';

const N = Number(process.env.SALESOPS_ROWS ?? 100000);

function build(n = N) {
  const f = new FiniDB();
  f.createModel('salesops');
  f.createPeriods('salesops', 'periods', { start: '2026-01', count: 12, grain: 'month' });
  f.createTable('salesops', 'territories', [{ id: 'name' }], { rows: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `Territory ${i}` })) });
  f.createTable('salesops', 'reps', [{ id: 'territory', ref: 'territories' }], { rows: Array.from({ length: 200 }, (_, i) => ({ id: `rep${i}`, territory: `t${i % 20}` })) });
  f.createTable('salesops', 'activity_types', [{ id: 'score', type: 'number' }], { rows: [{ id: 'call', score: 1 }, { id: 'email', score: 0.5 }, { id: 'meeting', score: 5 }, { id: 'demo', score: 8 }] });
  const types = ['call', 'email', 'meeting', 'demo'];
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = [];
  const periodIds = Array.from({ length: 12 }, (_, i) => `${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][i]}26`);
  for (let i = 0; i < n; i++) rows.push({ id: `a${i}`, rep: `rep${(rnd() * 200) | 0}`, activity_type: types[(rnd() * 4) | 0], period: periodIds[(rnd() * 12) | 0] });
  const t0 = performance.now();
  f.createTable('salesops', 'activities', [{ id: 'rep', ref: 'reps' }, { id: 'activity_type', ref: 'activity_types' }, { id: 'period', ref: 'periods' }, { id: 'score', type: 'number', computed: true }], { rows });
  const loadMs = performance.now() - t0;
  f.setRules('salesops', 'activities', 'score = activity_type.score');
  f.createPivot('salesops', 'territory_scores', { dims: [{ id: 'territory', table: 'territories' }, { id: 'period', table: 'periods' }], measures: [{ id: 'points' }], timeDim: 'period' });
  f.setRules('salesops', 'territory_scores', 'points = SUM(activities.score)');
  return { f, rows, loadMs, periodIds };
}

/** Direct computation of expected sums, independent of the engine. */
function expected(rows: { rep: string; activity_type: string; period: string }[], scoring: Record<string, number>, repTerr: (rep: string) => string) {
  const sums = new Map<string, number>();
  for (const r of rows) { const k = `${repTerr(r.rep)}|${r.period}`; sums.set(k, (sums.get(k) ?? 0) + scoring[r.activity_type]); }
  return sums;
}

test(`sales ops: ${N} activities roll up to territory x period and react to edits`, () => {
  const { f, rows, loadMs, periodIds } = build();
  const scoring: Record<string, number> = { call: 1, email: 0.5, meeting: 5, demo: 8 };
  const repTerr = (rep: string) => `t${Number(rep.slice(3)) % 20}`;
  let exp = expected(rows, scoring, repTerr);
  const check = (label: string) => {
    for (let t = 0; t < 20; t++) for (const p of periodIds) {
      const v = f.get('salesops', 'territory_scores', { territory: `t${t}`, period: p }) as number;
      const e = exp.get(`t${t}|${p}`) ?? 0;
      assert.ok(Math.abs(v - e) < 1e-6, `${label}: t${t} ${p} got ${v} expected ${e}`);
    }
  };
  let t0 = performance.now();
  check('initial');
  const firstMs = performance.now() - t0;

  // 1. change one activity's type: call -> demo
  rows[123].activity_type = 'demo';
  f.setCell('salesops', 'activities', 'a123', 'activity_type', 'demo');
  exp = expected(rows, scoring, repTerr);
  t0 = performance.now(); check('after one activity edit'); const editMs = performance.now() - t0;

  // 2. change the scoring table: call 1 -> 2
  scoring.call = 2;
  f.setCell('salesops', 'activity_types', 'call', 'score', 2);
  exp = expected(rows, scoring, repTerr);
  t0 = performance.now(); check('after scoring edit'); const scoringMs = performance.now() - t0;

  // 3. move a rep to another territory
  f.setCell('salesops', 'reps', 'rep7', 'territory', 't3');
  const repTerr2 = (rep: string) => rep === 'rep7' ? 't3' : repTerr(rep);
  exp = expected(rows, scoring, repTerr2);
  t0 = performance.now(); check('after rep move'); const moveMs = performance.now() - t0;

  console.log(`\n[reference evaluator, ${N} rows] load ${loadMs.toFixed(0)} ms · first full compute (240 cells) ${firstMs.toFixed(0)} ms · recompute after activity edit ${editMs.toFixed(0)} ms · after scoring edit ${scoringMs.toFixed(0)} ms · after rep move ${moveMs.toFixed(0)} ms`);
  console.log(f.query('salesops', { table: 'territory_scores', rows: ['territory'], cols: ['period'], filters: { territory: ['t0', 't1', 't2'] }, title: 'Territory scores (first three)' }));
});
