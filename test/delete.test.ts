import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiniDB, openDatabase } from '../src/index.js';

function build(f: FiniDB) {
  f.createModel('m');
  f.createTable('m', 'reps', [{ id: 'territory' }], { rows: [{ id: 'r1', territory: 'west' }, { id: 'r2', territory: 'east' }, { id: 'r3', territory: 'west' }] });
  f.createTable('m', 'deals', [{ id: 'rep', ref: 'reps' }, { id: 'acv', type: 'number' }, { id: 'terr', computed: true }], {
    rows: [{ id: 'd1', rep: 'r1', acv: 10 }, { id: 'd2', rep: 'r2', acv: 20 }, { id: 'd3', rep: 'r3', acv: 30 }, { id: 'd4', rep: 'r3', acv: 40 }],
  });
  f.setRules('m', 'deals', 'terr = rep.territory');
  f.createTable('m', 'lines', [], { rows: [{ id: 'bookings' }, { id: 'n' }] });
  f.createPivot('m', 'by_rep', { dims: [{ id: 'rep', table: 'reps' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
  f.setRules('m', 'by_rep', 'bookings = SUM(deals.acv)\nn = COUNT(deals.acv)');
}

test('deleteRows compacts columns, remaps references and recomputes', () => {
  for (const engine of ['reference', 'incremental'] as const) {
    const f = new FiniDB({ engine });
    build(f);
    assert.equal(f.get('m', 'by_rep', { rep: 'r3', line: 'bookings' }), 70);
    // delete a deal
    assert.equal(f.deleteRows('m', 'deals', ['d3']), 1);
    assert.equal(f.get('m', 'by_rep', { rep: 'r3', line: 'bookings' }), 40);
    assert.equal(f.getField('m', 'deals', 'd4', 'terr'), 'west');
    // delete a rep that deals point at: the ref becomes null and the member disappears from the pivot
    f.setValue('m', 'by_rep', { rep: 'r2', line: 'n' }, 99);
    assert.equal(f.deleteRows('m', 'reps', ['r2']), 1);
    assert.equal(f.getField('m', 'deals', 'd2', 'rep'), null);
    assert.equal(f.getField('m', 'deals', 'd2', 'terr'), null);
    assert.equal(f.getField('m', 'deals', 'd4', 'rep'), 'r3');
    assert.equal(f.get('m', 'by_rep', { rep: 'r3', line: 'bookings' }), 40);
    assert.equal(f.get('m', 'by_rep', { rep: 'r1', line: 'n' }), 1);
    assert.throws(() => f.get('m', 'by_rep', { rep: 'r2', line: 'n' }), /COORD_NO_MEMBER/);
    // drop a field
    f.dropField('m', 'deals', 'terr');
    assert.throws(() => f.getField('m', 'deals', 'd1', 'terr'), /SCHEMA_NO_FIELD/);
    assert.equal(f.get('m', 'by_rep', { rep: 'r1', line: 'bookings' }), 10);
  }
});

test('deletions persist through the oplog and snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finidb-del-'));
  try {
    let db = await openDatabase(dir);
    build(db.f);
    db.f.deleteRows('m', 'deals', ['d1']);
    db.f.dropField('m', 'deals', 'terr');
    await db.close();
    db = await openDatabase(dir);
    assert.equal(db.f.get('m', 'by_rep', { rep: 'r1', line: 'bookings' }), 0);
    assert.equal((db.f.model('m').table('deals') as any).rowCount, 3);
    await db.snapshot();
    await db.close();
    db = await openDatabase(dir);
    assert.equal(db.f.get('m', 'by_rep', { rep: 'r3', line: 'bookings' }), 70);
    await db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
