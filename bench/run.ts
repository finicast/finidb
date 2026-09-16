/**
 * B1 — sales ops benchmark (doc 06 §3). Usage: node --import tsx bench/run.ts [rows]
 */
import { FiniDB, IncrementalEngine } from '../src/index.js';

const N = Number(process.argv[2] ?? 100000);
const ITER = Number(process.env.BENCH_ITER ?? 20);

function build(engine: 'incremental' | 'reference') {
  const f = new FiniDB({ engine });
  f.createModel('salesops');
  f.createPeriods('salesops', 'periods', { start: '2026-01', count: 12, grain: 'month' });
  f.createTable('salesops', 'territories', [{ id: 'name' }], { rows: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `Territory ${i}` })) });
  f.createTable('salesops', 'reps', [{ id: 'territory', ref: 'territories' }], { rows: Array.from({ length: 200 }, (_, i) => ({ id: `rep${i}`, territory: `t${i % 20}` })) });
  f.createTable('salesops', 'activity_types', [{ id: 'score', type: 'number' }], { rows: [{ id: 'call', score: 1 }, { id: 'email', score: 0.5 }, { id: 'meeting', score: 5 }, { id: 'demo', score: 8 }] });
  const types = ['call', 'email', 'meeting', 'demo'];
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const periodIds = ['jan26', 'feb26', 'mar26', 'apr26', 'may26', 'jun26', 'jul26', 'aug26', 'sep26', 'oct26', 'nov26', 'dec26'];
  const rows = [];
  for (let i = 0; i < N; i++) rows.push({ id: `a${i}`, rep: `rep${(rnd() * 200) | 0}`, activity_type: types[(rnd() * 4) | 0], period: periodIds[(rnd() * 12) | 0] });
  const t0 = performance.now();
  f.createTable('salesops', 'activities', [{ id: 'rep', ref: 'reps' }, { id: 'activity_type', ref: 'activity_types' }, { id: 'period', ref: 'periods' }, { id: 'score', type: 'number', computed: true }], { rows });
  const loadMs = performance.now() - t0;
  f.setRules('salesops', 'activities', 'score = activity_type.score');
  f.createPivot('salesops', 'territory_scores', { dims: [{ id: 'territory', table: 'territories' }, { id: 'period', table: 'periods' }], measures: [{ id: 'points' }], timeDim: 'period' });
  f.setRules('salesops', 'territory_scores', 'points = SUM(activities.score)');
  return { f, loadMs, periodIds };
}

function readAll(f: FiniDB, periodIds: string[]) {
  let s = 0;
  for (let t = 0; t < 20; t++) for (const p of periodIds) s += f.get('salesops', 'territory_scores', { territory: `t${t}`, period: p }) as number;
  return s;
}

function timeIt(label: string, fn: () => void): number[] {
  const times: number[] = [];
  for (let i = 0; i < ITER; i++) { const t0 = performance.now(); fn(); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  console.log(`${label.padEnd(58)} p50 ${p(0.5).toFixed(3).padStart(8)} ms   p90 ${p(0.9).toFixed(3).padStart(8)} ms`);
  return times;
}

const { f, loadMs, periodIds } = build('incremental');
console.log(`B1 sales ops · ${N.toLocaleString()} activities · load ${loadMs.toFixed(0)} ms`);
let t0 = performance.now(); readAll(f, periodIds); console.log(`${'cold compute (score column + 240-cell pivot)'.padEnd(58)}     ${(performance.now() - t0).toFixed(1).padStart(8)} ms`);
const eng = f.evaluator as IncrementalEngine;
let k = 0;
timeIt('B1.1 one activity value changes → pivot read', () => { f.setCell('salesops', 'activities', `a${(k++ * 7919) % N}`, 'activity_type', ['call', 'email', 'meeting', 'demo'][k % 4]); readAll(f, periodIds); });
timeIt('B1.2 one scoring value changes (~25% of rows) → pivot read', () => { f.setCell('salesops', 'activity_types', 'call', 'score', 1 + (k++ % 5)); readAll(f, periodIds); });
timeIt('B1.3 one activity rep changes → pivot read', () => { f.setCell('salesops', 'activities', `a${(k++ * 104729) % N}`, 'rep', `rep${k % 200}`); readAll(f, periodIds); });
timeIt('B1.4 one rep moves territory (~500 rows) → pivot read', () => { f.setCell('salesops', 'reps', `rep${k++ % 200}`, 'territory', `t${k % 20}`); readAll(f, periodIds); });
timeIt('B1.8 reorient view (rows↔cols), no recompute', () => { f.query('salesops', { table: 'territory_scores', rows: ['period'], cols: ['territory'] }); });
console.log('engine stats', eng.stats, 'counters', eng.counters);
