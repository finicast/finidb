import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FiniDB, applyDocument, exportWorkbook } from '../src/index.js';

/** Read the members of a zip written by our writer (local headers, deflate or store). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8), csize = buf.readUInt32LE(off + 18), nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nlen);
    const start = off + 30 + nlen + xlen;
    const body = buf.subarray(start, start + csize);
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'));
    off = start + csize;
  }
  return out;
}
const coreweave = JSON.parse(readFileSync(new URL('../examples/coreweave.json', import.meta.url), 'utf8'));

test('the example three-statement model exports as a workbook of live formulas', () => {
  const f = new FiniDB();
  const modelId = applyDocument(f, coreweave).model;
  const r = exportWorkbook(f.db, modelId);
  const parts = unzip(r.buffer);
  assert.ok(parts.has('[Content_Types].xml') && parts.has('xl/workbook.xml') && parts.has('xl/styles.xml'));
  assert.ok(r.sheets.some(s => /income statement/i.test(s)) && r.sheets.some(s => /balance sheet/i.test(s)) && r.sheets.includes('Rules'), r.sheets.join(', '));
  assert.ok(r.formulas > 100, `formula cells: ${r.formulas}`);
  assert.equal(r.values, 0, `every rule-governed cell has a formula; notes: ${r.notes.join(' | ')}`);
  const is = parts.get(`xl/worksheets/sheet${r.sheets.findIndex(s => /income statement/i.test(s)) + 1}.xml`)!;
  // forecast revenue: previous cell times one plus the driver read from the Assumptions sheet
  const m = /<f>\(([A-Z]+\d+)\*\(1\+'Assumptions'!([A-Z]+\d+)\)\)<\/f>/.exec(is);
  assert.ok(m, 'revenue[frame=fcst] compiles to PREV × (1 + assumptions.revenue_growth) as cell references');
  // a cross-sheet reference into the cash-flow statement from the balance sheet
  const bs = parts.get(`xl/worksheets/sheet${r.sheets.findIndex(s => /balance sheet/i.test(s)) + 1}.xml`)!;
  assert.ok(/'Cash flow'!/.test(bs), 'balance sheet cells reference the cash-flow sheet');
  // inputs are values in blue, formulas black: the input style index differs from the formula style index
  assert.ok(/<c r="[A-Z]+\d+" s="\d+"><v>1915(\.4)?<\/v><\/c>/.test(is), 'historical revenue is a plain value');
});

test('a revolver with iterative calculation exports with the workbook iteration flag', () => {
  const f = new FiniDB();
  const modelId = applyDocument(f, {
    model: 'rev', iterate: { maxIterations: 200, tolerance: 0.0001 },
    periods: { start: '2025-01', count: 4, grain: 'year', histUntil: '2025-12-31' },
    pivots: { fin: { lines: ['ebitda', 'capex', 'interest', 'borrow', 'debt', 'cash'],
      inputs: { debt: { fy2025: 1000 }, cash: { fy2025: 600 }, ebitda: { fy2026: 300, fy2027: 400, fy2028: 900 }, capex: { fy2026: 700, fy2027: 500, fy2028: 200 } },
      rules: 'interest[frame=fcst] = 0.08 * (PREV(debt) + debt) / 2\nborrow[frame=fcst] = MAX(0, 500 - (PREV(cash) + ebitda - interest - capex))\ndebt[frame=fcst] = PREV(debt) + borrow\ncash[frame=fcst] = PREV(cash) + ebitda - interest - capex + borrow' } },
  }).model;
  const r = exportWorkbook(f.db, modelId);
  const wb = unzip(r.buffer).get('xl/workbook.xml')!;
  assert.match(wb, /iterate="1" iterateCount="200" iterateDelta="0.0001"/);
  assert.equal(r.values, 0, r.notes.join(' | '));
});

test('a ledger rollup compiles to SUMIFS over the table sheet', () => {
  const f = new FiniDB();
  f.createModel('s');
  f.createPeriods('s', 'periods', { start: '2026-01', count: 3, grain: 'month' });
  f.createTable('s', 'reps', [{ id: 'region' }], { rows: [{ id: 'ana', region: 'na' }, { id: 'bo', region: 'eu' }] });
  f.createTable('s', 'types', [{ id: 'score', type: 'number' }], { rows: [{ id: 'call', score: 1 }, { id: 'demo', score: 8 }] });
  f.createTable('s', 'acts', [{ id: 'rep', ref: 'reps' }, { id: 'type', ref: 'types' }, { id: 'period', ref: 'periods' }, { id: 'score', type: 'number', computed: true }],
    { rows: [{ id: 'a1', rep: 'ana', type: 'call', period: 'jan26' }, { id: 'a2', rep: 'ana', type: 'demo', period: 'jan26' }, { id: 'a3', rep: 'bo', type: 'demo', period: 'feb26' }] });
  f.setRules('s', 'acts', 'score = type.score');
  f.createPivot('s', 'points', { dims: [{ id: 'rep', table: 'reps' }, { id: 'period', table: 'periods' }], timeDim: 'period' });
  f.setRules('s', 'points', 'value = SUM(acts.score)\nvalue[period=mar26] = SUM(acts.score[type != call])');
  const r = exportWorkbook(f.db, 's');
  const parts = unzip(r.buffer);
  const pts = parts.get(`xl/worksheets/sheet${r.sheets.indexOf('points') + 1}.xml`)!;
  assert.match(pts, /SUMIFS\('acts'!\$E\$2:\$E\$4,'acts'!\$[A-D]\$2:\$[A-D]\$4,&quot;ana&quot;,'acts'!\$[A-D]\$2:\$[A-D]\$4,&quot;jan26&quot;\)/, 'inferred correlations become SUMIFS criteria');
  assert.match(pts, /&quot;&lt;&gt;call&quot;/, 'a != selector becomes a <> criterion');
  const acts = parts.get(`xl/worksheets/sheet${r.sheets.indexOf('acts') + 1}.xml`)!;
  assert.match(acts, /INDEX\('types'!\$B\$2:\$B\$3,MATCH\(C2,'types'!\$A\$2:\$A\$3,0\)\)/, 'a path through a reference becomes INDEX/MATCH');
  assert.equal(r.values, 0, r.notes.join(' | '));
});

// The real check: a second spreadsheet engine evaluates the exported formulas and must reproduce the engine's values.
import { HyperFormula } from 'hyperformula';
import type { Workbook } from '../src/export/xlsx.js';

function toHyperFormula(wb: Workbook): HyperFormula {
  const sheets: Record<string, (string | number | boolean | null)[][]> = {};
  for (const sh of wb.sheets) {
    const grid: (string | number | boolean | null)[][] = [];
    for (const [ref, cell] of sh.cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
      let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(m[2]);
      while (grid.length < row) grid.push([]);
      const line = grid[row - 1]; while (line.length < col) line.push(null);
      line[col - 1] = cell.f ? `=${cell.f}` : cell.v === undefined ? null : cell.v;
    }
    sheets[sh.name] = grid;
  }
  return HyperFormula.buildFromSheets(sheets, { licenseKey: 'gpl-v3', smartRounding: false });
}

function checkAgainstEngine(f: FiniDB, modelId: string, r: ReturnType<typeof exportWorkbook>): number {
  const hf = toHyperFormula(r.workbook);
  let compared = 0;
  for (const t of f.model(modelId).tables.values()) {
    if (t.kind !== 'pivot') continue;
    const sheetId = hf.getSheetId(r.sheets.find(s => s.toLowerCase() === (t.name || t.id).toLowerCase())!)!;
    const lineDim = t.dims[0], timeDim = t.dims[1];
    for (let li = 0; li < lineDim.table.rowCount; li++) for (let pi = 0; pi < timeDim.table.rowCount; pi++) {
      const v = f.evaluator.cell(t, t.defaultMeasure, Int32Array.from([li, pi]));
      if (typeof v !== 'number') continue;
      const x = hf.getCellValue({ sheet: sheetId, row: li + 1, col: pi + 1 });
      assert.equal(typeof x, 'number', `${t.id} ${lineDim.table.rowId(li)} @ ${timeDim.table.rowId(pi)}: HyperFormula gave ${JSON.stringify(x)}, engine ${v}; formula ${hf.getCellFormula({ sheet: sheetId, row: li + 1, col: pi + 1 })}`);
      assert.ok(Math.abs((x as number) - v) / Math.max(1, Math.abs(v)) < 1e-9, `${t.id} ${lineDim.table.rowId(li)} @ ${timeDim.table.rowId(pi)}: HyperFormula ${x} vs engine ${v}`);
      compared++;
    }
  }
  return compared;
}

test('a second spreadsheet engine reproduces every cell of the three-statement model from the exported formulas', () => {
  const f = new FiniDB();
  const modelId = applyDocument(f, coreweave).model;
  const compared = checkAgainstEngine(f, modelId, exportWorkbook(f.db, modelId));
  assert.ok(compared > 100, `compared ${compared} cells`);
});

test('the ledger rollup workbook evaluates to the engine\'s values (SUMIFS, INDEX/MATCH)', () => {
  const f = new FiniDB();
  f.createModel('s');
  f.createPeriods('s', 'periods', { start: '2026-01', count: 3, grain: 'month' });
  f.createTable('s', 'reps', [{ id: 'region' }], { rows: [{ id: 'ana', region: 'na' }, { id: 'bo', region: 'eu' }] });
  f.createTable('s', 'types', [{ id: 'score', type: 'number' }], { rows: [{ id: 'call', score: 1 }, { id: 'demo', score: 8 }] });
  f.createTable('s', 'acts', [{ id: 'rep', ref: 'reps' }, { id: 'type', ref: 'types' }, { id: 'period', ref: 'periods' }, { id: 'score', type: 'number', computed: true }],
    { rows: [{ id: 'a1', rep: 'ana', type: 'call', period: 'jan26' }, { id: 'a2', rep: 'ana', type: 'demo', period: 'jan26' }, { id: 'a3', rep: 'bo', type: 'demo', period: 'feb26' }, { id: 'a4', rep: 'bo', type: 'call', period: 'mar26' }] });
  f.setRules('s', 'acts', 'score = type.score');
  f.createPivot('s', 'points', { dims: [{ id: 'rep', table: 'reps' }, { id: 'period', table: 'periods' }], timeDim: 'period' });
  f.setRules('s', 'points', 'value = SUM(acts.score)\nvalue[period=mar26] = SUM(acts.score[type != call]) + COUNT(acts.id)');
  const compared = checkAgainstEngine(f, 's', exportWorkbook(f.db, 's'));
  assert.equal(compared, 6);
});
