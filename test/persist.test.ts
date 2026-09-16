import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FiniDB } from '../src/index.js';
import { openDatabase, readMeta } from '../src/persist/store.js';
import { readOplog, createPersistentFiniDB, replay } from '../src/persist/oplog.js';
import { saveSnapshot, loadSnapshot, readSnapshotHeader } from '../src/persist/snapshot.js';

function tmpdir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'finidb-persist-')); }

/** The NVDA model from test/nvda.test.ts, built through whatever facade is given. */
function buildNvda(f: FiniDB) {
  f.createModel('nvda');
  f.createPeriods('nvda', 'periods', { start: '2024-01', count: 6, grain: 'year', histUntil: '2026-12-31' });
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
      { id: '13', account: 'revenue', period: 'fy2025', amount: 3 },
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
}

const nvdaQuery = (f: FiniDB) => f.query('nvda', { table: 'income_statement', rows: ['line'], cols: ['period'], title: 'NVDA', formats: { gross_margin: 'percent' } }) as string;

test('NVDA survives close/reopen from the oplog, from a snapshot, and from snapshot + log tail', async () => {
  const dir = tmpdir();
  try {
    // 1. build through the persistent wrapper
    let db = await openDatabase(dir);
    buildNvda(db.f);
    const expected = nvdaQuery(db.f);
    assert.match(expected, /\| Revenue/);
    const seqAfterBuild = db.seq;
    await db.close();
    const ops = readOplog(dir);
    assert.equal(ops.length, seqAfterBuild);
    assert.deepEqual(ops.slice(0, 2).map(o => o.op), ['createModel', 'createPeriods']);
    assert.ok(ops.every((o, i) => o.seq === i + 1 && typeof o.ts === 'string'));

    // 2. reopen from the oplog only
    db = await openDatabase(dir);
    assert.equal(nvdaQuery(db.f), expected);
    assert.equal(db.seq, seqAfterBuild);

    // 3. snapshot, delete the log, reopen from the snapshot alone
    const snapFile = await db.snapshot();
    await db.close();
    assert.ok(fs.existsSync(snapFile));
    assert.equal(readMeta(dir).snapshotSeq, seqAfterBuild);
    const { header } = readSnapshotHeader(snapFile);
    assert.equal(header.format, 'FDB1');
    assert.equal(header.seq, seqAfterBuild);
    assert.equal(fs.readFileSync(snapFile).toString('latin1', 0, 4), 'FDB1');
    fs.rmSync(path.join(dir, 'oplog.jsonl'));
    db = await openDatabase(dir);
    assert.equal(nvdaQuery(db.f), expected);
    assert.equal(db.seq, seqAfterBuild, 'seq continues after the snapshot even without a log');

    // 4. snapshot + 3 extra edits in the log tail
    db.f.setValue('nvda', 'assumptions', { driver: 'revenue_growth', period: 'fy2027' }, 0.5);
    db.f.setValue('nvda', 'income_statement', { line: 'revenue', period: 'fy2028' }, 1000);
    db.f.setCell('nvda', 'periods', 'fy2026', 'frame', 'fcst');
    const edited = nvdaQuery(db.f);
    assert.notEqual(edited, expected);
    assert.equal(db.seq, seqAfterBuild + 3);
    await db.close();
    assert.equal(readOplog(dir).length, 3);
    assert.ok(readOplog(dir).every(o => o.seq > seqAfterBuild));

    db = await openDatabase(dir);
    assert.equal(nvdaQuery(db.f), edited);
    const g = (line: string, period: string) => db.f.get('nvda', 'income_statement', { line, period }) as number;
    assert.ok(Math.abs(g('revenue', 'fy2027') - 130500 * 1.5) < 1e-6); // fy2026 is now fcst with blank growth, then +50%
    assert.equal(g('revenue', 'fy2028'), 1000);
    assert.equal(db.f.getField('nvda', 'periods', 'fy2026', 'frame'), 'fcst');
    // the log still only holds the tail; the snapshot covers the rest
    assert.equal(readOplog(dir).length, 3);
    await db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('self-referencing table and a 20k-row insert through a blob', async () => {
  const dir = tmpdir();
  try {
    let db = await openDatabase(dir, { fsync: 'always' });
    const f = db.f;
    f.createModel('m');
    f.createTable('m', 'regions', [{ id: 'parent', ref: 'regions' }, { id: 'pct_of_parent', type: 'number' }], {
      rows: [{ id: 'world', parent: null, pct_of_parent: 1 }, { id: 'na', parent: 'world', pct_of_parent: 0.6 }, { id: 'eu', parent: 'world', pct_of_parent: 0.4 }, { id: 'us', parent: 'na', pct_of_parent: 0.9 }, { id: 'ca', parent: 'na', pct_of_parent: 0.1 }],
    });
    f.createTable('m', 'lines', [], { rows: [{ id: 'goal' }, { id: 'sum_of_subs' }, { id: 'topdown' }, { id: 'activity' }] });
    // 20k activities: ref, number, date, bool, text columns
    const leaves = ['us', 'ca', 'eu'];
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: `a${i}`, region: leaves[i % 3], amount: (i % 7) + 1, day: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, done: i % 2 === 0, note: i % 5 === 0 ? null : `note ${i % 11}` }));
    f.createTable('m', 'activities', [{ id: 'region', ref: 'regions' }, { id: 'amount', type: 'number' }, { id: 'day', type: 'date' }, { id: 'done', type: 'bool' }, { id: 'note' }], { rows });
    f.createPivot('m', 'quota', { dims: [{ id: 'region', table: 'regions' }, { id: 'line', table: 'lines' }], lineDim: 'line' });
    f.setValue('m', 'quota', { region: 'us', line: 'goal' }, 90);
    f.setValue('m', 'quota', { region: 'ca', line: 'goal' }, 10);
    f.setValue('m', 'quota', { region: 'eu', line: 'goal' }, 50);
    f.setValue('m', 'quota', { region: 'world', line: 'topdown' }, 1000);
    f.setRules('m', 'quota', `
      sum_of_subs = SUM(goal[region.parent = @region])
      topdown     = topdown[region = @region.parent] * region.pct_of_parent
      activity    = SUM(activities.amount)
    `);
    const q = (f: FiniDB) => f.query('m', { table: 'quota', rows: ['region'], cols: ['line'] }) as string;
    const expected = q(f);
    assert.equal(f.get('m', 'quota', { region: 'na', line: 'sum_of_subs' }), 100);
    const usTotal = f.get('m', 'quota', { region: 'us', line: 'activity' }) as number;
    assert.ok(usTotal > 0);
    await db.close();

    // the 20k batch went to a blob, not the log
    const ops = readOplog(dir);
    const big = ops.find(o => o.op === 'insertRows' && o.args.table === 'activities')!;
    assert.ok(big, 'insertRows op for activities');
    assert.equal(big.args.count, 20000);
    assert.equal(big.args.rows, undefined);
    assert.match(String(big.args.blob), /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dir, 'blobs', `${big.args.blob}.json`)));
    assert.ok(fs.statSync(path.join(dir, 'oplog.jsonl')).size < 20000, 'log stays small');
    const small = ops.find(o => o.op === 'insertRows' && o.args.table === 'regions')!;
    assert.equal((small.args.rows as unknown[]).length, 5);

    // reopen from the log (blob is re-read)
    db = await openDatabase(dir);
    assert.equal(q(db.f), expected);
    assert.equal(db.f.getField('m', 'regions', 'us', 'parent'), 'na');
    assert.equal(db.f.getField('m', 'activities', 'a3', 'day'), 19726); // 2024-01-04
    assert.equal(db.f.getField('m', 'activities', 'a3', 'done'), false);
    assert.equal(db.f.getField('m', 'activities', 'a5', 'note'), null);
    assert.equal(db.f.getField('m', 'activities', 'a6', 'note'), 'note 6');
    assert.equal(db.f.model('m').table('activities').kind === 'tabular' && (db.f.model('m').table('activities') as any).rowCount, 20000);

    // snapshot, drop the log and blobs, reopen from the snapshot alone (self-ref column restored directly)
    const snap = await db.snapshot();
    await db.close();
    fs.rmSync(path.join(dir, 'oplog.jsonl'));
    fs.rmSync(path.join(dir, 'blobs'), { recursive: true });
    const { header } = readSnapshotHeader(snap);
    const regions = header.models[0].tables.find(t => t.id === 'regions')!;
    assert.equal(regions.fields.find(x => x.id === 'parent')!.ref, 'regions');
    assert.ok(header.models[0].tables.findIndex(t => t.id === 'regions') < header.models[0].tables.findIndex(t => t.id === 'activities'), 'ref targets come first');
    db = await openDatabase(dir);
    assert.equal(q(db.f), expected);
    assert.equal(db.f.getField('m', 'regions', 'us', 'parent'), 'na');
    assert.equal(db.f.getField('m', 'regions', 'world', 'parent'), null);
    assert.equal(db.f.get('m', 'quota', { region: 'us', line: 'activity' }), usTotal);
    // a later edit on top of the snapshot still propagates and is logged
    db.f.setCell('m', 'regions', 'ca', 'parent', 'eu');
    assert.equal(db.f.get('m', 'quota', { region: 'na', line: 'sum_of_subs' }), 90);
    await db.close();
    db = await openDatabase(dir);
    assert.equal(db.f.get('m', 'quota', { region: 'eu', line: 'sum_of_subs' }), 10);
    await db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('saveSnapshot/loadSnapshot and replay work stand-alone; nested facade calls are logged once', () => {
  const dir = tmpdir();
  try {
    const f = createPersistentFiniDB(dir, { fsync: 'never' });
    buildNvda(f);
    f.oplog.close();
    const ops = readOplog(dir);
    // createTable with rows is logged as createTable + insertRows, and addField is not logged separately
    assert.equal(ops.filter(o => o.op === 'addField').length, 0);
    assert.equal(ops.filter(o => o.op === 'createTable').length, 3);
    assert.equal(ops.filter(o => o.op === 'insertRows').length, 3);

    const g = new FiniDB();
    replay(g, dir);
    assert.equal(nvdaQuery(g), nvdaQuery(f));

    const file = path.join(dir, 'x.fdb');
    saveSnapshot(g, file, { seq: 42 });
    const h = loadSnapshot(file);
    assert.equal(nvdaQuery(h), nvdaQuery(f));
    assert.equal(readSnapshotHeader(file).header.seq, 42);
    // inputs only: the header carries pivot inputs and rules, never computed cells
    const is = readSnapshotHeader(file).header.models[0].pivots.find(p => p.id === 'income_statement')!;
    assert.equal(is.inputs.length, 0);
    assert.equal(is.rules.length, 15);
    const asm = readSnapshotHeader(file).header.models[0].pivots.find(p => p.id === 'assumptions')!;
    assert.equal(asm.inputs[0][1].length, 12);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
