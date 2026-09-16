import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiniDB, startServer, filePersistence } from '../src/index.js';

test('a rejected strict setRules append leaves the previous rules and values untouched', () => {
  for (const engine of ['reference', 'incremental'] as const) {
    const f = new FiniDB({ engine });
    f.createModel('m');
    f.createTable('m', 'lines', [], { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    f.createPivot('m', 'p', { dims: [{ id: 'line', table: 'lines' }], lineDim: 'line' });
    f.setRules('m', 'p', 'a = 1\nb = a + 1\nc = b + 1');
    assert.equal(f.get('m', 'p', { line: 'c' }), 3);
    assert.throws(() => f.setRules('m', 'p', 'c = bb + 1', { replace: false }), /UNKNOWN_NAME/);
    const p = f.model('m').table('p');
    assert.equal(p.rules.length, 3);
    assert.ok(p.rules.every(r => r.status === 'ok'), 'earlier rules must stay valid');
    assert.equal(f.get('m', 'p', { line: 'c' }), 3);
    // non-strict: the bad rule is stored, marked invalid, and does not break the rest
    const res = f.setRules('m', 'p', 'c = bb + 1', { replace: false, strict: false });
    assert.equal(res[0].status, 'invalid');
    assert.match(res[0].error ?? '', /bb/);
    assert.equal(f.get('m', 'p', { line: 'b' }), 2);
  }
});

test('compile errors carry a fix through setRules', () => {
  const f = new FiniDB();
  f.createModel('m');
  f.createTable('m', 'reps', [], { rows: [{ id: 'r1' }] });
  f.createTable('m', 'deals', [{ id: 'owner', ref: 'reps' }, { id: 'closer', ref: 'reps' }, { id: 'acv', type: 'number' }], { rows: [{ id: 'd1', owner: 'r1', closer: 'r1', acv: 5 }] });
  f.createTable('m', 'lines', [], { rows: [{ id: 'bookings' }] });
  f.createPivot('m', 'by_rep', { dims: [{ id: 'rep', table: 'reps' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
  try { f.setRules('m', 'by_rep', 'bookings = SUM(deals.acv)'); assert.fail('expected a throw'); }
  catch (e: any) { assert.equal(e.code, 'AMBIGUOUS_GROUP_KEY'); assert.match(e.fix, /deals\.acv\[(owner|closer)=@rep\]/); }
});

test('COUNT and COUNTA over a text column agree between engines', () => {
  const build = (engine: 'reference' | 'incremental') => {
    const f = new FiniDB({ engine });
    f.createModel('m');
    f.createTable('m', 'reps', [], { rows: [{ id: 'r1' }, { id: 'r2' }] });
    f.createTable('m', 'deals', [{ id: 'rep', ref: 'reps' }, { id: 'name' }, { id: 'acv', type: 'number' }], { rows: [{ id: 'd1', rep: 'r1', name: 'x', acv: 5 }, { id: 'd2', rep: 'r1', name: null, acv: 7 }, { id: 'd3', rep: 'r2', name: 'z', acv: null }] });
    f.createTable('m', 'lines', [], { rows: [{ id: 'n' }, { id: 'na' }, { id: 'nb' }, { id: 'ids' }] });
    f.createPivot('m', 'p', { dims: [{ id: 'rep', table: 'reps' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
    f.setRules('m', 'p', 'n = COUNT(deals.acv)\nna = COUNTA(deals.name)\nnb = COUNTBLANK(deals.name)\nids = COUNTA(deals.id)');
    return f;
  };
  const a = build('reference'), b = build('incremental');
  for (const rep of ['r1', 'r2']) for (const line of ['n', 'na', 'nb', 'ids']) assert.deepEqual(b.get('m', 'p', { rep, line }), a.get('m', 'p', { rep, line }), `${rep}.${line}`);
  assert.equal(b.get('m', 'p', { rep: 'r1', line: 'na' }), 1);
  assert.equal(b.get('m', 'p', { rep: 'r1', line: 'ids' }), 2);
  b.setCell('m', 'deals', 'd2', 'name', 'y');
  a.setCell('m', 'deals', 'd2', 'name', 'y');
  assert.equal(b.get('m', 'p', { rep: 'r1', line: 'na' }), 2);
  assert.equal(b.get('m', 'p', { rep: 'r1', line: 'nb' }), 0);
});

test('two dimensions over the same member table resolve selectors by dimension id', () => {
  for (const engine of ['reference', 'incremental'] as const) {
    const f = new FiniDB({ engine });
    f.createModel('m');
    f.createPeriods('m', 'periods', { start: '2026-01', count: 4, grain: 'month' });
    f.createTable('m', 'lines', [], { rows: [{ id: 'x' }, { id: 'prev_x' }, { id: 'cum_x' }] });
    f.createPivot('m', 'cohorts', { dims: [{ id: 'cohort', table: 'periods' }, { id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' });
    const per = ['jan26', 'feb26', 'mar26', 'apr26'];
    per.forEach((p, i) => f.setValue('m', 'cohorts', { cohort: 'jan26', line: 'x', period: p }, 10 * (i + 1)));
    f.setRules('m', 'cohorts', 'prev_x = x[period-1]\ncum_x = SUM(x[period = first..this])');
    assert.equal(f.get('m', 'cohorts', { cohort: 'jan26', line: 'prev_x', period: 'mar26' }), 20);
    assert.equal(f.get('m', 'cohorts', { cohort: 'jan26', line: 'cum_x', period: 'mar26' }), 60);
    assert.equal(f.get('m', 'cohorts', { cohort: 'feb26', line: 'prev_x', period: 'mar26' }), null);
  }
});

test('server persists databases across restarts through filePersistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finidb-srv-'));
  try {
    let h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
    const post = (path: string, body: unknown) => fetch(`${h.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/db', { name: 'demo' })).status, 201);
    assert.equal((await post('/db/demo/models', { id: 'm' })).status, 201);
    const r = await post('/db/demo/tables', { model: 'm', id: 't', fields: [{ id: 'v', type: 'number' }], rows: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] });
    assert.ok(r.status < 300, await r.text());
    await h.close();
    h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
    const s = await (await fetch(`${h.url}/db/demo/schema`)).json() as any;
    const t = JSON.stringify(s);
    assert.match(t, /"t"/);
    assert.match(t, /rowCount":2|"rows":2/);
    await h.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
