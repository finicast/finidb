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

test('deleting a member of a dimension does not leave other cells reading the wrong row', async () => {
  const { FiniDB } = await import('../src/index.js');
  for (const engine of ['incremental', 'reference'] as const) {
    const f = new FiniDB({ engine });
    f.createModel('m');
    f.createTable('m', 'names', [{ id: 'name' }], { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    f.createTable('m', 'quotes', [{ id: 'name', ref: 'names' }, { id: 'px', type: 'number' }],
      { rows: [{ id: 'q1', name: 'a', px: 1 }, { id: 'q2', name: 'b', px: 2 }, { id: 'q3', name: 'c', px: 3 }, { id: 'q4', name: 'd', px: 4 }] });
    f.createPivot('m', 'p', { dims: [{ id: 'name', table: 'names' }], lineDim: 'name', measures: [{ id: 'value' }] });
    f.setRules('m', 'p', 'value = SUM(quotes.px[name=@name])');
    const px = (id: string) => f.get('m', 'p', { name: id });
    assert.deepEqual([px('a'), px('b'), px('c'), px('d')], [1, 2, 3, 4], engine);

    // drop a member (and its quote): the cells of the survivors must still read their own rows
    f.deleteRows('m', 'quotes', ['q2']);
    f.deleteRows('m', 'names', ['b']);
    assert.deepEqual([px('a'), px('c'), px('d')], [1, 3, 4], `${engine}: after a delete`);

    // and the same when a member arrives, which moves the indexes the other way
    f.insertRows(f.model('m').table('names') as never, [{ id: 'e' }]);
    f.insertRows(f.model('m').table('quotes') as never, [{ id: 'q5', name: 'e', px: 5 }]);
    assert.deepEqual([px('a'), px('c'), px('d'), px('e')], [1, 3, 4, 5], `${engine}: after an insert`);
  }
});

test('a copied database carries the model and its values, and the two then move apart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finidb-copy-'));
  let h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
  try {
    const post = (path: string, body?: unknown) => fetch(`${h.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const cell = async (db: string, line: string) => (await (await fetch(`${h.url}/db/${db}/cells?table=p&line=${line}`)).json() as { value: number }).value;
    assert.equal((await post('/db', { name: 'src' })).status, 201);
    await post('/db/src/models', { id: 'm' });
    await post('/db/src/tables', { model: 'm', id: 'lines', rows: [{ id: 'price' }, { id: 'qty' }, { id: 'revenue' }] });
    assert.equal((await post('/db/src/tables', { model: 'm', id: 'p', kind: 'pivot', dims: [{ id: 'line', table: 'lines' }], lineDim: 'line', measures: [{ id: 'value' }] })).status, 201);
    await post('/db/src/cells', [{ table: 'p', at: { line: 'price' }, value: 10 }, { table: 'p', at: { line: 'qty' }, value: 3 }]);
    assert.ok((await post('/db/src/tables/p/rules', { rules: 'revenue = price * qty' })).status < 300);
    assert.equal(await cell('src', 'revenue'), 30);

    assert.equal((await post('/db/src/copy', { to: 'mine' })).status, 201);
    assert.equal(await cell('mine', 'revenue'), 30);                 // values and rules came across

    // the copy is its own database: a change to one leaves the other alone
    await post('/db/mine/cells', [{ table: 'p', at: { line: 'qty' }, value: 5 }]);
    assert.equal(await cell('mine', 'revenue'), 50);
    assert.equal(await cell('src', 'revenue'), 30);
    assert.equal((await post('/db/src/copy', { to: 'mine' })).status, 409);       // the name is taken
    assert.equal((await post('/db/src/copy', { to: 'no spaces' })).status, 400);

    // and it survives a restart on its own files
    await h.close();
    h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
    assert.equal(await cell('mine', 'revenue'), 50);
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a tracked table records who added each row and who changed it, and the log keeps the history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finidb-track-'));
  let h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
  try {
    const as = (who: string, name: string) => ({ 'content-type': 'application/json', 'x-finidb-actor': who, 'x-finidb-actor-name': name });
    const post = (path: string, body: unknown, who = 'u1', name = 'Ada') => fetch(`${h.url}${path}`, { method: 'POST', headers: as(who, name), body: JSON.stringify(body) });
    const rows = async (table = 'notes') => (await (await fetch(`${h.url}/db/t/tables/${table}/rows?limit=50`)).json() as { rows: Record<string, unknown>[] }).rows;
    assert.equal((await post('/db', { name: 't' })).status, 201);
    await post('/db/t/models', { id: 'm' });
    assert.equal((await post('/db/t/tables', { model: 'm', id: 'notes', fields: [{ id: 'note' }], track: true })).status, 201);
    await post('/db/t/tables/notes/rows', { rows: [{ id: 'a', note: 'first' }] });

    let r = (await rows())[0];
    assert.equal(r.added_by, 'u1');
    assert.equal(r.changed_by, 'u1');
    assert.equal(typeof r.added_at, 'number');                     // a day number, so PERIOD() can roll it up
    assert.deepEqual((await rows('people')).map(p => [p.id, p.name]), [['u1', 'Ada']]);   // the people table fills itself

    // someone else changes the row: added_by stays, changed_by moves
    await fetch(`${h.url}/db/t/tables/notes/rows`, { method: 'PUT', headers: as('u2', 'Grace'), body: JSON.stringify({ rows: [{ id: 'a', note: 'second' }] }) });
    r = (await rows())[0];
    assert.equal(r.note, 'second');
    assert.equal(r.added_by, 'u1');
    assert.equal(r.changed_by, 'u2');
    assert.deepEqual((await rows('people')).map(p => p.id).sort(), ['u1', 'u2']);

    // the engine's columns are its own: a caller that sends them is ignored
    await post('/db/t/tables/notes/rows', { rows: [{ id: 'b', note: 'third', added_by: 'u1', changed_by: 'u1' }] }, 'u2', 'Grace');
    assert.equal((await rows()).find(x => x.id === 'b')!.added_by, 'u2');

    // the log says who did what, newest first, and keeps the overwritten value
    const hist = await (await fetch(`${h.url}/db/t/history?table=notes`)).json() as { history: { op: string; by?: string; byName?: string; rows?: string[] }[] };
    assert.deepEqual(hist.history.map(x => [x.op, x.by]).slice(0, 3), [['insertRows', 'u2'], ['upsertRows', 'u2'], ['insertRows', 'u1']]);
    assert.equal(hist.history[0].byName, 'Grace');

    // and it all comes back the same after a restart, stamps and all
    await h.close();
    h = await startServer({ port: 0, host: 'localhost', dataDir: dir, persistence: filePersistence() });
    r = (await rows())[0];
    assert.equal(r.added_by, 'u1');
    assert.equal(r.changed_by, 'u2');
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
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
