/**
 * Excel export: every pivot becomes a sheet (row dims down, the time dim across), every table a sheet,
 * and every rule-governed cell gets a live Excel formula compiled from its rule at that cell — the agent
 * never writes a cell formula, the person gets a workbook they can audit and extend. Inputs are blue,
 * formulas black, the finance convention. Cells whose rule has no faithful Excel form keep their value
 * and are listed on a Notes sheet. A model with iterative calculation turns on Excel's.
 *
 * Built on the reference evaluator: resolving a reference at a cell gives the concrete member sets the
 * evaluator itself would read, so the compiler turns those into addresses and ranges instead of
 * re-deriving selector semantics.
 */
import type { Database, Model, Table, Pivot, Field, Dim, Measure } from '../schema/schema.js';
import type { Rule } from '../schema/rules.js';
import type { Node, Selector } from '../lang/ast.js';
import { Value, isError } from '../store/column.js';
import { ReferenceEvaluator, CompileError, type Ctx, type Resolved } from '../eval/reference.js';
import { writeXlsx, a1, colLetter, sheetRef, sheetName, excelSerial, type Cell, type Sheet, type StyleKey, type NumFmt, type Font, type Workbook, type ChartSpec } from './xlsx.js';

export interface ExportOptions {
  /** write formulas without cached results, so a spreadsheet must recalculate on load (tests) */
  cachedValues?: boolean;
  /** tables longer than this get values instead of per-row formulas for computed fields */
  maxFormulaRows?: number;
  /** an aggregate that cannot be a range is written as a list of cells up to this many; beyond it the cell keeps its value */
  maxListRefs?: number;
  /** dashboards to lay out as sheets: each card a block of live references into the pivot sheets, chart cards with a native chart */
  dashboards?: DashboardExport[];
}
/** A dashboard as the hosted service stores it, reduced to what the sheet needs: cards in display order, each over one pivot view. */
export interface DashboardCardExport {
  title: string;
  kind: 'table' | 'chart' | 'kpi';
  chartType?: string;                 // line | bar | stackedBar | area | waterfall | scatter
  series?: 'rows' | 'cols';           // which axis of the view is a series
  editable?: boolean;
  view: { table: string; rows: string[]; cols: string[]; pages?: Record<string, string>; measure?: string; filters?: Record<string, string[]> };
}
export interface DashboardExport { name: string; cards: DashboardCardExport[] }
export interface ExportResult { buffer: Buffer; sheets: string[]; formulas: number; values: number; notes: string[]; /** the sheets as written, for tests and other writers */ workbook: Workbook }

class NotExportable extends Error {}

interface PivotSheet {
  pivot: Pivot; measure: Measure; sheet: Sheet; rowDims: Dim[]; colDim?: Dim;
  rowOf: Map<string, number>;        // row-dim member tuple key → sheet row
  firstDataCol: number; rowTuples: number[][];
}
interface TableSheet { table: Table; sheet: Sheet; colOf: Map<Field, number> }

const AGG_XL: Record<string, string> = { SUM: 'SUM', AVG: 'AVERAGE', AVERAGE: 'AVERAGE', COUNT: 'COUNT', COUNTA: 'COUNTA', COUNTBLANK: 'COUNTBLANK', MIN: 'MIN', MAX: 'MAX', MEDIAN: 'MEDIAN' };
const IFS_XL: Record<string, string> = { SUM: 'SUMIFS', AVG: 'AVERAGEIFS', AVERAGE: 'AVERAGEIFS', COUNT: 'COUNTIFS', COUNTA: 'COUNTIFS', MIN: 'MINIFS', MAX: 'MAXIFS' };
/** functions with the same shape in Excel */
const SAME = new Set(['ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'TRUNC', 'MROUND', 'POWER', 'LOG', 'RAND', 'RANDBETWEEN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'LOWER', 'UPPER', 'TRIM', 'REPLACE', 'SUBSTITUTE', 'EXACT', 'TEXT', 'VALUE', 'DATE', 'TODAY', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'DAYS', 'EOMONTH', 'DATEDIF', 'YEARFRAC', 'PMT', 'PV', 'FV', 'NPER', 'SLN', 'SYD', 'DDB', 'IPMT', 'PPMT', 'RATE', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISLOGICAL', 'ISERROR', 'NOT']);
const XL_ERROR: Record<string, string> = { DIV0: '#DIV/0!', REF: '#REF!', NUM: '#NUM!', CYCLE: '#N/A', ITER: '#N/A' };

export function exportWorkbook(db: Database, modelId: string, opts: ExportOptions = {}): ExportResult {
  const model = db.model(modelId);
  return new Compiler(db, opts).run(model);
}

class Compiler extends ReferenceEvaluator {
  private pivotSheets = new Map<string, PivotSheet>();
  private tableSheets = new Map<Table, TableSheet>();
  private taken = new Set<string>();
  private notes = new Map<string, number>();
  private counts = { formulas: 0, values: 0 };
  constructor(db: Database, private opts: ExportOptions) { super(db); }

  run(model: Model): ExportResult {
    const pivots = [...model.tables.values()].filter((t): t is Pivot => t.kind === 'pivot');
    const tables = [...model.tables.values()].filter((t): t is Table => t.kind === 'tabular');
    for (const p of pivots) for (const m of p.measures) this.planPivot(p, m, p.measures.length > 1);
    for (const t of tables) this.planTable(t);
    for (const ps of this.pivotSheets.values()) this.fillPivot(ps);
    for (const ts of this.tableSheets.values()) this.fillTable(ts);
    const dashSheets: Sheet[] = [];
    for (const d of this.opts.dashboards ?? []) { try { dashSheets.push(this.dashboardSheet(model, d)); } catch (e) { this.note(`dashboard "${d.name}" skipped — ${e instanceof Error ? e.message : String(e)}`); } }
    const sheets: Sheet[] = [...dashSheets, ...[...this.pivotSheets.values()].map(p => p.sheet), ...[...this.tableSheets.values()].map(t => t.sheet), this.rulesSheet(model)];
    const notes = [...this.notes.entries()].map(([n, k]) => (k > 1 ? `${n} (${k} cells)` : n));
    if (notes.length) sheets.push(this.notesSheet(notes));
    const workbook: Workbook = { sheets, iterate: model.iterate, cachedValues: this.opts.cachedValues };
    const buffer = writeXlsx(workbook);
    return { buffer, sheets: sheets.map(s => s.name), formulas: this.counts.formulas, values: this.counts.values, notes, workbook };
  }

  // ---------- layout ----------

  private planPivot(p: Pivot, m: Measure, qualify: boolean) {
    const name = sheetName(qualify ? `${p.name || p.id} ${m.name || m.id}` : (p.name || p.id), this.taken);
    const colDim = p.timeDim ?? (p.dims.length >= 2 ? p.dims[p.dims.length - 1] : undefined);
    const rowDims = p.dims.filter(d => d !== colDim);
    const lists = rowDims.map(d => Array.from({ length: d.table.rowCount }, (_, i) => i));
    const rowTuples = cartesian(lists);
    const rowOf = new Map<string, number>();
    rowTuples.forEach((t, i) => rowOf.set(t.join(','), i + 2));
    const sheet: Sheet = { name, cells: new Map(), colWidths: {}, freeze: { rows: 1, cols: rowDims.length } };
    const firstDataCol = rowDims.length + 1;
    rowDims.forEach((d, k) => { sheet.cells.set(a1(1, k + 1), { v: d.name || d.id, style: 'general/bold' }); sheet.colWidths![k + 1] = k === rowDims.length - 1 ? 32 : 18; });
    if (colDim) for (let i = 0; i < colDim.table.rowCount; i++) { sheet.cells.set(a1(1, firstDataCol + i), { v: label(colDim.table, i), style: 'general/bold' }); sheet.colWidths![firstDataCol + i] = 12; }
    else { sheet.cells.set(a1(1, firstDataCol), { v: m.name || m.id, style: 'general/bold' }); sheet.colWidths![firstDataCol] = 14; }
    for (const rt of rowTuples) { const row = rowOf.get(rt.join(','))!; rt.forEach((i, k) => sheet.cells.set(a1(row, k + 1), { v: label(rowDims[k].table, i), style: 'general/normal' })); }
    this.pivotSheets.set(`${p.iid}:${m.iid}`, { pivot: p, measure: m, sheet, rowDims, colDim, rowOf, firstDataCol, rowTuples });
  }
  private planTable(t: Table) {
    const name = sheetName(t.name || t.id, this.taken);
    const sheet: Sheet = { name, cells: new Map(), colWidths: {}, freeze: { rows: 1, cols: 1 } };
    const colOf = new Map<Field, number>();
    t.fields.forEach((f, k) => { colOf.set(f, k + 1); sheet.cells.set(a1(1, k + 1), { v: f.name || f.id, style: 'general/bold' }); sheet.colWidths![k + 1] = k === 0 ? 18 : 14; });
    this.tableSheets.set(t, { table: t, sheet, colOf });
  }

  /** A1 address (with sheet) of a pivot cell. */
  private pivotAddr(p: Pivot, m: Measure, coord: ArrayLike<number>, from?: Sheet): string {
    const ps = this.pivotSheets.get(`${p.iid}:${m.iid}`);
    if (!ps) throw new NotExportable(`${p.id} is outside this model`);
    const key = ps.rowDims.map(d => coord[p.dimIndex(d)]).join(',');
    const row = ps.rowOf.get(key); if (row === undefined) throw new NotExportable('row not laid out');
    const col = ps.colDim ? ps.firstDataCol + coord[p.dimIndex(ps.colDim)] : ps.firstDataCol;
    return (from === ps.sheet ? '' : `${sheetRef(ps.sheet.name)}!`) + a1(row, col);
  }
  private tableAddr(t: Table, f: Field, row: number, from?: Sheet): string {
    const ts = this.tableSheets.get(t);
    if (!ts) throw new NotExportable(`${t.id} is outside this model`);
    return (from === ts.sheet ? '' : `${sheetRef(ts.sheet.name)}!`) + a1(row + 2, ts.colOf.get(f)!);
  }
  private tableCol(t: Table, f: Field): string {
    const ts = this.tableSheets.get(t);
    if (!ts) throw new NotExportable(`${t.id} is outside this model`);
    const c = colLetter(ts.colOf.get(f)!);
    return `${sheetRef(ts.sheet.name)}!$${c}$2:$${c}$${Math.max(2, t.rowCount + 1)}`;
  }

  // ---------- filling ----------

  private fillPivot(ps: PivotSheet) {
    const { pivot: p, measure: m, sheet } = ps;
    const fmtCols = p.dims.map(d => d.table.hasField('format') ? d.table.field('format').column : undefined);
    const nCols = ps.colDim ? ps.colDim.table.rowCount : 1;
    for (const rt of ps.rowTuples) {
      const row = ps.rowOf.get(rt.join(','))!;
      const cells: { col: number; cell: Cell; input: boolean }[] = [];
      let allInt = true, pct = false;
      for (let ci = 0; ci < nCols; ci++) {
        const coord = new Int32Array(p.dims.length);
        rt.forEach((i, k) => { coord[p.dimIndex(ps.rowDims[k])] = i; });
        if (ps.colDim) coord[p.dimIndex(ps.colDim)] = ci;
        for (let d = 0; d < p.dims.length; d++) { const c = fmtCols[d]; if (c && /percent|%/i.test(String(c.get(coord[d]) ?? ''))) pct = true; }
        const input = p.getInput(m, coord);
        const ctx: Ctx = { kind: 'pivot', pivot: p, coord };
        const cell: Cell = {};
        let isInput = false;
        if (input !== undefined) { cell.v = scalar(input); isInput = true; }
        else {
          const rule = this.governingRule(p.rules, m.id, ctx);
          if (!rule) continue;
          const v = this.cell(p, m, coord);
          this.setValue(cell, v);
          const f = this.compileRule(rule, ctx, sheet, `${p.id}.${m.id}`);
          if (f) { cell.f = f; this.counts.formulas++; } else this.counts.values++;
        }
        if (typeof cell.v === 'number' && !Number.isInteger(cell.v)) allInt = false;
        cells.push({ col: ps.firstDataCol + ci, cell, input: isInput });
      }
      const fmt: NumFmt = pct ? 'pct' : allInt ? 'int' : 'dec';
      for (const c of cells) { c.cell.style = style(c.cell, fmt, c.input ? 'input' : 'normal'); sheet.cells.set(a1(row, c.col), c.cell); }
    }
  }

  private fillTable(ts: TableSheet) {
    const { table: t, sheet } = ts;
    const maxRows = this.opts.maxFormulaRows ?? 5000;
    for (const f of t.fields) {
      const col = ts.colOf.get(f)!;
      let allInt = true;
      const made: Cell[] = [];
      for (let r = 0; r < t.rowCount; r++) {
        const cell: Cell = {};
        if (f.computed) {
          const ctx: Ctx = { kind: 'row', table: t, row: r };
          const rule = this.governingRule(t.rules, f.id, ctx);
          const v = this.field(t, f, r);
          this.setValue(cell, f.type === 'ref' && typeof v === 'number' ? f.refTable!.rowId(v) : v);
          if (rule && r < maxRows) { const fx = this.compileRule(rule, ctx, sheet, `${t.id}.${f.id}`); if (fx) { cell.f = fx; this.counts.formulas++; } else this.counts.values++; }
          else if (rule) this.counts.values++;
        } else {
          const raw = f.column.get(r);
          cell.v = f.type === 'ref' ? (typeof raw === 'number' ? f.refTable!.rowId(raw) : null) : f.type === 'date' && typeof raw === 'number' ? excelSerial(raw) : scalar(raw as Value);
        }
        if (typeof cell.v === 'number' && !Number.isInteger(cell.v)) allInt = false;
        made.push(cell);
      }
      const fmt: NumFmt = f.type === 'date' ? 'date' : f.type === 'number' ? (allInt ? 'int' : 'dec') : /percent|%/i.test(f.format ?? '') ? 'pct' : 'general';
      made.forEach((cell, r) => { cell.style = style(cell, fmt, 'normal'); if (cell.v !== undefined || cell.f) sheet.cells.set(a1(r + 2, col), cell); });
    }
    if (t.rowCount >= maxRows && t.fields.some(f => f.computed)) this.note(`${t.id}: computed columns are values beyond row ${maxRows} (table has ${t.rowCount} rows)`);
  }

  private setValue(cell: Cell, v: Value) {
    if (isError(v)) { cell.error = XL_ERROR[v.error] ?? '#VALUE!'; cell.v = cell.error; return; }
    cell.v = scalar(v);
  }
  private compileRule(rule: Rule, ctx: Ctx, from: Sheet, where: string): string | undefined {
    try { return this.compileNode(rule.ast!, ctx, from); }
    catch (e) {
      const why = e instanceof NotExportable ? e.message : e instanceof CompileError ? e.detail : e instanceof Error ? e.message : String(e);
      this.note(`${where}: "${rule.formula}" kept as values — ${why}`);
      return undefined;
    }
  }
  private note(n: string) { this.notes.set(n, (this.notes.get(n) ?? 0) + 1); }

  // ---------- the compiler ----------

  private compileNode(n: Node, ctx: Ctx, from: Sheet): string {
    switch (n.k) {
      case 'num': return numLit(n.v);
      case 'str': return strLit(n.v);
      case 'bool': return n.v ? 'TRUE' : 'FALSE';
      case 'blank': return '""';
      case 'un': return n.op === '-' ? `-(${this.compileNode(n.e, ctx, from)})` : `NOT(${this.compileNode(n.e, ctx, from)})`;
      case 'bin': {
        const l = this.compileNode(n.l, ctx, from), r = this.compileNode(n.r, ctx, from);
        switch (n.op) {
          case 'and': return `AND(${l},${r})`;
          case 'or': return `OR(${l},${r})`;
          case '!=': return `(${l}<>${r})`;
          default: return `(${l}${n.op}${r})`;
        }
      }
      case 'at': return literal(this.evalAt(n.path, ctx));
      case 'ref': return this.compileRef(n, ctx, from);
      case 'call': return this.compileCall(n, ctx, from);
    }
  }

  private compileRef(n: Extract<Node, { k: 'ref' }>, ctx: Ctx, from: Sheet): string {
    const st = this.classifyRef(n, ctx);
    if (st.k === 'field' && ctx.kind === 'row') {
      const addr = this.tableAddr(ctx.table, st.field, ctx.row, from);
      return st.path.length ? this.lookupChain(st.field, addr, st.path) : addr;
    }
    if (st.k === 'row') return String((ctx as Extract<Ctx, { kind: 'row' }>).row);
    const res = this.resolve(n, ctx, false);
    return this.compileScalar(res, ctx, from);
  }
  private compileScalar(res: Resolved, ctx: Ctx, from: Sheet): string {
    switch (res.k) {
      case 'value': return literal(res.v);
      case 'member': return literal(this.valueOf(res, ctx));
      case 'rowref': return literal(this.valueOf(res, ctx));
      case 'cells': {
        if (res.path.length) throw new NotExportable('a path on a measure value');
        if (res.sets.some(s => s !== 'all' && s.length === 0)) return '0';
        if (res.sets.some(s => s === 'all' || s.length !== 1)) throw new NotExportable('a set where a single cell is needed');
        return this.pivotAddr(res.pivot, res.measure, res.sets.map(s => (s as number[])[0]), from);
      }
      case 'rows': {
        const rows = this.rowsOf(res, ctx);
        if (rows.length === 0) return '0';
        if (rows.length !== 1) throw new NotExportable('a set where a single row is needed');
        const addr = this.tableAddr(res.table, res.field, rows[0], from);
        return res.path.length ? this.lookupChain(res.field, addr, res.path) : addr;
      }
    }
  }
  /** `field.attr` on a ref field: INDEX/MATCH into the referenced table's sheet, one hop per path segment. */
  private lookupChain(refField: Field, keyExpr: string, path: string[]): string {
    if (refField.type !== 'ref' || !refField.refTable) throw new NotExportable(`${refField.id} is not a reference`);
    const t = refField.refTable;
    const f = t.field(path[0]);
    const idField = t.fields[0];
    const expr = `INDEX(${this.tableCol(t, f)},MATCH(${keyExpr},${this.tableCol(t, idField)},0))`;
    return path.length === 1 ? expr : this.lookupChain(f, expr, path.slice(1));
  }

  private compileCall(n: Extract<Node, { k: 'call' }>, ctx: Ctx, from: Sheet): string {
    const name = n.name;
    const args = () => n.args.map(a => this.compileNode(a, ctx, from));
    switch (name) {
      case 'IF': { const c = this.compileNode(n.args[0], ctx, from); const a = n.args.length > 1 ? this.compileNode(n.args[1], ctx, from) : 'TRUE'; const b = n.args.length > 2 ? this.compileNode(n.args[2], ctx, from) : '0'; return `IF(${c},${a},${b})`; }
      case 'AND': case 'OR': case 'IFERROR': return `${name}(${args().join(',')})`;
      case 'PREV': case 'NEXT': {
        const k = n.args.length > 1 ? this.evalNode(n.args[1], ctx) : 1;
        if (typeof k !== 'number') throw new NotExportable('PREV/NEXT offset must be a number');
        return this.compileRef(this.shifted(n.args[0], ctx, { k: 'offset', dim: this.timeDim(ctx).id, by: name === 'PREV' ? -k : k }), ctx, from);
      }
      case 'CUMSUM': { const t = this.timeDim(ctx); return `SUM(${this.rangeOf(this.shifted(n.args[0], ctx, { k: 'range', path: [t.id], from: { k: 'kw', v: 'first' }, to: { k: 'kw', v: 'this' } }), ctx, from)})`; }
      case 'TRAILING': {
        const t = this.timeDim(ctx);
        const k = this.evalNode(n.args[1], ctx); if (typeof k !== 'number') throw new NotExportable('TRAILING window must be a number');
        const agg = n.args[2]?.k === 'ref' ? n.args[2].parts[0].toUpperCase() : 'AVG';
        const xl = AGG_XL[agg]; if (!xl) throw new NotExportable(`TRAILING with ${agg}`);
        return `${xl}(${this.rangeOf(this.shifted(n.args[0], ctx, { k: 'range', path: [t.id], from: { k: 'kw', v: 'this', by: -(k - 1) }, to: { k: 'kw', v: 'this' } }), ctx, from)})`;
      }
      case 'FIRST': case 'LAST': {
        if (n.args.length === 1 && n.args[0].k === 'ref' && ctx.kind === 'pivot') {
          const res = this.resolve(n.args[0], ctx, true);
          if (res.k === 'cells' && res.sets.every(s => s !== 'all' && s.length === 1)) return this.compileRef(this.shifted(n.args[0], ctx, { k: 'eq', path: [this.timeDim(ctx).id], op: '=', value: { k: 'kw', v: name === 'FIRST' ? 'first' : 'last' } }), ctx, from);
        }
        throw new NotExportable(`${name} over a set`);
      }
      case 'PERIOD': return literal(this.evalNode(n, ctx));
      case 'DIVIDE': { const [a, b] = args(); return `(${a}/${b})`; }
      case 'COALESCE': { if (n.args.length !== 2) throw new NotExportable('COALESCE with more than two arguments'); const [a, b] = args(); return `IF(${a}="",${b},${a})`; }
      case 'CONCAT': return `CONCATENATE(${args().join(',')})`;
      case 'STRING': return `(${args()[0]}&"")`;
      case 'CONTAINS': { const [s, t] = args(); return `ISNUMBER(SEARCH(${t},${s}))`; }
      case 'STARTSWITH': { const [s, t] = args(); return `(LOWER(LEFT(${s},LEN(${t})))=LOWER(${t}))`; }
      case 'ENDSWITH': { const [s, t] = args(); return `(LOWER(RIGHT(${s},LEN(${t})))=LOWER(${t}))`; }
      case 'QUARTER': return `ROUNDUP(MONTH(${args()[0]})/3,0)`;
      case 'NPV': case 'IRR': {
        const parts = n.args.map(a => a.k === 'ref' ? this.rangeOrScalar(a, ctx, from) : this.compileNode(a, ctx, from));
        return `${name}(${parts.join(',')})`;
      }
    }
    if (name in AGG_XL) return this.compileAggregate(name, n, ctx, from);
    if (SAME.has(name)) return `${name}(${args().join(',')})`;
    throw new NotExportable(`${name}() has no Excel form`);
  }

  private compileAggregate(name: string, n: Extract<Node, { k: 'call' }>, ctx: Ctx, from: Sheet): string {
    const xl = AGG_XL[name];
    // the workhorse: one table column, correlated to the current cell → SUMIFS and friends
    if (n.args.length === 1 && n.args[0].k === 'ref') {
      const res = this.resolve(n.args[0], ctx, true);
      if (res.k === 'rows') {
        const ifs = this.ifsForm(name, res, n.args[0].selectors, ctx);
        if (ifs) return ifs;
        const rows = this.rowsOf(res, ctx);
        if (rows.length === 0) return name === 'SUM' || name.startsWith('COUNT') ? '0' : '""';
        const max = this.opts.maxListRefs ?? 100;
        if (rows.length > max || res.path.length) throw new NotExportable(`${name} over ${rows.length} rows of ${res.table.id} has no range form`);
        return `${xl}(${rows.map(r => this.tableAddr(res.table, res.field, r, from)).join(',')})`;
      }
    }
    const parts: string[] = [];
    for (const a of n.args) parts.push(a.k === 'ref' ? this.rangeOrScalar(a, ctx, from) : this.compileNode(a, ctx, from));
    return `${xl}(${parts.join(',')})`;
  }
  private rangeOrScalar(a: Extract<Node, { k: 'ref' }>, ctx: Ctx, from: Sheet): string {
    const res = this.resolve(a, ctx, true);
    if (res.k === 'cells') return this.rangeOf(a, ctx, from, res);
    if (res.k === 'rows') { const rows = this.rowsOf(res, ctx); const max = this.opts.maxListRefs ?? 100; if (rows.length > max || res.path.length) throw new NotExportable(`a set of ${rows.length} rows has no range form`); return rows.map(r => this.tableAddr(res.table, res.field, r, from)).join(','); }
    return this.compileScalar(res, ctx, from);
  }
  /** The cells of a pivot set as a contiguous A1 range when they lie in one row or one column, else a list. */
  private rangeOf(a: Extract<Node, { k: 'ref' }>, ctx: Ctx, from: Sheet, pre?: Resolved): string {
    const res = pre ?? this.resolve(a, ctx, true);
    if (res.k !== 'cells') return this.compileScalar(res, ctx, from);
    if (res.path.length) throw new NotExportable('a path on a measure value');
    const p = res.pivot, m = res.measure;
    const lists = res.sets.map((s, i) => s === 'all' ? Array.from({ length: p.dims[i].table.rowCount }, (_, k) => k) : s);
    if (lists.some(l => l.length === 0)) return '0';
    const coords = cartesian(lists);
    const cells = coords.map(c => ({ c, addr: this.pivotAddr(p, m, c, from) }));
    if (cells.length === 1) return cells[0].addr;
    const rc = cells.map(x => parseA1(x.addr));
    const sameSheet = rc.every(x => x.sheet === rc[0].sheet);
    if (sameSheet) {
      const rows = new Set(rc.map(x => x.row)), cols = new Set(rc.map(x => x.col));
      const contiguous = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.every((v, i) => i === 0 || v === s[i - 1] + 1); };
      if (rows.size === 1 && contiguous(rc.map(x => x.col))) { const cs = rc.map(x => x.col); return `${rc[0].sheet}${a1(rc[0].row, Math.min(...cs))}:${a1(rc[0].row, Math.max(...cs))}`; }
      if (cols.size === 1 && contiguous(rc.map(x => x.row))) { const rs = rc.map(x => x.row); return `${rc[0].sheet}${a1(Math.min(...rs), rc[0].col)}:${a1(Math.max(...rs), rc[0].col)}`; }
      if (contiguous([...rows]) && contiguous([...cols]) && rows.size * cols.size === cells.length) { const rs = [...rows], cs = [...cols]; return `${rc[0].sheet}${a1(Math.min(...rs), Math.min(...cs))}:${a1(Math.max(...rs), Math.max(...cs))}`; }
    }
    const max = this.opts.maxListRefs ?? 100;
    if (cells.length > max) throw new NotExportable(`a set of ${cells.length} cells has no range form`);
    return cells.map(x => x.addr).join(',');
  }

  /**
   * SUMIFS / COUNTIFS / AVERAGEIFS / MINIFS / MAXIFS over a table's columns when every restriction on the rows
   * is a direct field equal to a literal or to the current cell's member. Attribute paths and multi-hop
   * correlations have no criteria form and fall through to a cell list.
   */
  private ifsForm(name: string, res: Extract<Resolved, { k: 'rows' }>, selectors: Selector[], ctx: Ctx): string | undefined {
    const fn = IFS_XL[name];
    if (!fn || res.path.length || res.rows !== 'all') return undefined;
    if (name === 'COUNT' && res.field.type !== 'number') return undefined;   // COUNT counts numbers: a cell list keeps Excel's own semantics for text
    const t = res.table;
    const crit: [string, string][] = [];   // [column range, criteria expression]
    const covered = new Set<Table>();
    const alts: [string, (string | number)[]][] = [];   // an `in` list: the aggregate is summed over the alternatives (SUM/COUNT only)
    for (const s of selectors) {
      if (s.k === 'offset' || s.k === 'range') return undefined;
      if (s.path.length !== 1 || s.path[0] === 'row') return undefined;
      const f = t.field(s.path[0]);
      const col = this.tableCol(t, f);
      switch (s.k) {
        case 'eq': { if (s.value.k === 'kw') return undefined; crit.push([col, criteria(s.op === '=' ? '=' : '<>', s.value.v)]); break; }
        case 'cmp': crit.push([col, criteria(s.op, s.value)]); break;
        case 'in': { if (s.not) return undefined; if (name !== 'SUM' && !name.startsWith('COUNT')) return undefined; alts.push([col, s.values]); break; }
        case 'corr': {
          const v = this.evalAt(s.right, ctx);
          if (isError(v)) return undefined;
          crit.push([col, criteria('=', v === null ? '' : (v as string | number))]);
          if (f.type === 'ref' && f.refTable) covered.add(f.refTable);
          break;
        }
      }
    }
    if (ctx.kind === 'pivot') {
      for (const d of ctx.pivot.dims) {
        if (covered.has(d.table) || d.table === t) continue;
        const paths = pathsTo(t, d.table, 2);
        if (paths.length === 0) continue;
        if (paths.length > 1 || paths[0].length !== 1) return undefined;   // a two-hop key has no criteria form
        const f = paths[0][0];
        crit.push([this.tableCol(t, f), strLit(d.table.rowId(ctx.coord[ctx.pivot.dimIndex(d)]))]);
      }
    }
    const valueCol = this.tableCol(t, res.field);
    const one = (extra: [string, string][]) => {
      const all = [...crit, ...extra];
      if (fn === 'COUNTIFS') { all.push([valueCol, '"<>"']); return `COUNTIFS(${all.map(([c, k]) => `${c},${k}`).join(',')})`; }
      if (!all.length) return `${fn.replace('IFS', '')}(${valueCol})`;
      return `${fn}(${valueCol},${all.map(([c, k]) => `${c},${k}`).join(',')})`;
    };
    if (!alts.length) return one([]);
    if (alts.length > 1) return undefined;
    const [col, values] = alts[0];
    return `(${values.map(v => one([[col, criteria('=', v)]])).join('+')})`;
  }

  private timeDim(ctx: Ctx): Dim {
    if (ctx.kind !== 'pivot') throw new NotExportable('time functions need a pivot');
    const d = ctx.pivot.timeDim ?? (ctx.pivot.dims.length === 1 ? ctx.pivot.dims[0] : undefined);
    if (!d) throw new NotExportable(`${ctx.pivot.id} has no time dimension`);
    return d;
  }
  private shifted(ref: Node, _ctx: Ctx, sel: Selector): Extract<Node, { k: 'ref' }> {
    if (ref.k !== 'ref') throw new NotExportable('time functions take a reference');
    return { ...ref, selectors: [...ref.selectors, sel] };
  }

  // ---------- dashboards ----------

  /** A dashboard as a sheet: cards stacked top to bottom, each a table of live references into its pivot's sheet, chart cards followed by a native chart over that table. */
  private dashboardSheet(model: Model, d: DashboardExport): Sheet {
    const sheet: Sheet = { name: sheetName(d.name || 'Dashboard', this.taken), cells: new Map(), colWidths: { 1: 34 }, charts: [] };
    let row = 1;
    for (const card of d.cards) {
      const t = model.table(card.view.table);
      if (t.kind !== 'pivot') { this.note(`dashboard "${d.name}": card "${card.title}" is not over a pivot`); continue; }
      const p = t; const m = card.view.measure ? p.measure(card.view.measure) ?? p.defaultMeasure : p.defaultMeasure;
      const dimOf = (id: string) => { const dm = p.dim(id); if (!dm) throw new NotExportable(`'${id}' is not a dimension of ${p.id}`); return dm; };
      const rowDims = card.view.rows.map(dimOf), colDims = card.view.cols.map(dimOf);
      const members = (dm: Dim) => { const f = card.view.filters?.[dm.id]; const all = Array.from({ length: dm.table.rowCount }, (_, i) => i); if (!f) return all; return f.map(id => dm.table.memberIndex(id)).filter(i => i >= 0); };
      let rowTuples = cartesian(rowDims.map(members)), colTuples = cartesian(colDims.map(members));
      if (card.kind === 'kpi') { rowTuples = rowTuples.slice(0, 1); colTuples = colTuples.slice(-1); }
      const base = new Int32Array(p.dims.length);
      for (const dm of p.dims) { if (rowDims.includes(dm) || colDims.includes(dm)) continue; const id = card.view.pages?.[dm.id]; const i = id === undefined ? 0 : dm.table.memberIndex(id); base[p.dimIndex(dm)] = i < 0 ? 0 : i; }
      const fmtCols = p.dims.map(dm => dm.table.hasField('format') ? dm.table.field('format').column : undefined);
      // title row, then a header row, then one row per row tuple
      sheet.cells.set(a1(row, 1), { v: card.title, style: 'general/bold' });
      if (card.editable) { const ps = this.pivotSheets.get(`${p.iid}:${m.iid}`); sheet.cells.set(a1(row, 2), { v: `Inputs: edit the blue cells on the ${ps ? `'${ps.sheet.name}'` : p.id} sheet; this table follows them.`, style: 'general/muted' }); }
      const head = row + 1, first = head + 1;
      sheet.cells.set(a1(head, 1), { v: rowDims.map(dm => dm.name || dm.id).join(' / ') || ' ', style: 'general/bold' });
      colTuples.forEach((ct, c) => { sheet.cells.set(a1(head, 2 + c), { v: ct.map((i, k) => label(colDims[k].table, i)).join(' / ') || (m.name || m.id), style: 'general/bold' }); sheet.colWidths![2 + c] = Math.max(sheet.colWidths![2 + c] ?? 0, 12); });
      let allPct = colTuples.length > 0 && rowTuples.length > 0;
      rowTuples.forEach((rt, r) => {
        const rr = first + r;
        sheet.cells.set(a1(rr, 1), { v: rt.map((i, k) => label(rowDims[k].table, i)).join(' / ') || (m.name || m.id), style: 'general/normal' });
        let pct = false, allInt = true; const made: { col: number; cell: Cell }[] = [];
        colTuples.forEach((ct, c) => {
          const coord = base.slice();
          rt.forEach((i, k) => { coord[p.dimIndex(rowDims[k])] = i; });
          ct.forEach((i, k) => { coord[p.dimIndex(colDims[k])] = i; });
          for (let di = 0; di < p.dims.length; di++) { const fc = fmtCols[di]; if (fc && /percent|%/i.test(String(fc.get(coord[di]) ?? ''))) pct = true; }
          const cell: Cell = { f: this.pivotAddr(p, m, coord, sheet) };
          this.setValue(cell, this.cell(p, m, coord));
          if (typeof cell.v === 'number' && !Number.isInteger(cell.v)) allInt = false;
          made.push({ col: 2 + c, cell });
        });
        if (!pct) allPct = false;
        for (const x of made) { x.cell.style = style(x.cell, pct ? 'pct' : allInt ? 'int' : 'dec', 'normal'); sheet.cells.set(a1(rr, x.col), x.cell); this.counts.formulas++; }
      });
      let next = first + rowTuples.length + 1;
      if (card.kind === 'chart' && rowTuples.length && colTuples.length) {
        const type: ChartSpec['type'] = card.chartType === 'bar' || card.chartType === 'waterfall' ? 'bar' : card.chartType === 'stackedBar' ? 'stackedBar' : card.chartType === 'area' ? 'area' : 'line';
        const ref = sheetRef(sheet.name);
        const abs = (r: number, c: number) => `$${colLetter(c)}$${r}`;
        const lastCol = 1 + colTuples.length, lastRow = first + rowTuples.length - 1;
        const byRows = card.series !== 'cols';
        const series = byRows
          ? rowTuples.map((_, r) => ({ nameRef: `${ref}!${abs(first + r, 1)}`, valuesRef: `${ref}!${abs(first + r, 2)}:${abs(first + r, lastCol)}` }))
          : colTuples.map((_, c) => ({ nameRef: `${ref}!${abs(head, 2 + c)}`, valuesRef: `${ref}!${abs(first, 2 + c)}:${abs(lastRow, 2 + c)}` }));
        const categoriesRef = byRows ? `${ref}!${abs(head, 2)}:${abs(head, lastCol)}` : `${ref}!${abs(first, 1)}:${abs(lastRow, 1)}`;
        const height = 16;
        sheet.charts!.push({ type, title: card.title, anchor: { fromCol: 0, fromRow: next - 1, toCol: Math.max(9, lastCol + 1), toRow: next - 1 + height }, categoriesRef, series, percent: allPct });
        next += height + 1;
      }
      row = next;
    }
    sheet.cells.set(a1(row, 1), { v: 'Every cell on this sheet refers to the statement sheets; edit inputs there (blue) and this dashboard follows.', style: 'general/muted' });
    return sheet;
  }

  // ---------- documentation sheets ----------

  private rulesSheet(model: Model): Sheet {
    const sheet: Sheet = { name: sheetName('Rules', this.taken), cells: new Map(), colWidths: { 1: 22, 2: 16, 3: 30, 4: 70, 5: 10 }, freeze: { rows: 1, cols: 0 } };
    ['Table', 'Target', 'When', 'Formula', 'Status'].forEach((h, i) => sheet.cells.set(a1(1, i + 1), { v: h, style: 'general/bold' }));
    let row = 2;
    for (const t of model.tables.values()) for (const r of t.rules) {
      const when = r.when.map(c => `${c.left} ${c.op} ${Array.isArray(c.right) ? `(${c.right.join(', ')})` : c.right}`).join(', ');
      [t.id, r.target, when, r.formula, r.status === 'ok' ? 'ok' : `invalid: ${r.error ?? ''}`].forEach((v, i) => sheet.cells.set(a1(row, i + 1), { v, style: i === 3 ? 'text/normal' : 'general/normal' }));
      row++;
    }
    sheet.cells.set(a1(row + 1, 1), { v: 'Rules are what the model is made of; the cell formulas on the other sheets were compiled from them. Inputs are blue, formulas black.', style: 'general/muted' });
    return sheet;
  }
  private notesSheet(notes: string[]): Sheet {
    const sheet: Sheet = { name: sheetName('Notes', this.taken), cells: new Map(), colWidths: { 1: 120 } };
    sheet.cells.set('A1', { v: 'Cells that kept their computed value because the rule has no faithful Excel formula', style: 'general/bold' });
    notes.forEach((n, i) => sheet.cells.set(a1(i + 2, 1), { v: n, style: 'general/normal' }));
    return sheet;
  }
}

// ---------- helpers ----------

function cartesian(lists: number[][]): number[][] {
  let out: number[][] = [[]];
  for (const l of lists) { const next: number[][] = []; for (const t of out) for (const v of l) next.push([...t, v]); out = next; }
  return out;
}
function label(t: Table, i: number): string { const nf = t.fieldById.get('name'); const n = nf ? nf.column.get(i) : null; return n === null || n === undefined || n === '' ? t.rowId(i) : String(n); }
function scalar(v: Value | undefined): number | string | boolean | null {
  if (v === undefined || v === null) return null;
  if (isError(v)) return `#${v.error}`;
  return v as number | string | boolean;
}
function style(cell: Cell, fmt: NumFmt, font: Font): StyleKey {
  const f: NumFmt = typeof cell.v === 'number' || cell.f ? fmt : 'general';
  return `${f}/${font}`;
}
function numLit(v: number): string { return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(v)) : '0'; }
function strLit(s: string): string { return `"${s.replace(/"/g, '""')}"`; }
function literal(v: Value): string {
  if (v === null || v === undefined) return '""';
  if (isError(v)) throw new NotExportable(`a value that is an error (#${v.error})`);
  if (typeof v === 'number') return numLit(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return strLit(String(v));
}
function criteria(op: string, v: string | number | boolean): string {
  const s = typeof v === 'number' ? String(v) : String(v);
  return strLit(`${op}${s}`);
}
function parseA1(addr: string): { sheet: string; row: number; col: number } {
  const bang = addr.lastIndexOf('!');
  const sheet = bang >= 0 ? addr.slice(0, bang + 1) : '';
  const m = /^([A-Z]+)(\d+)$/.exec(addr.slice(bang + 1))!;
  let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet, row: Number(m[2]), col };
}
function pathsTo(from: Table, to: Table, maxHops: number): Field[][] {
  const out: Field[][] = [];
  const rec = (t: Table, acc: Field[]) => {
    if (acc.length >= maxHops) return;
    for (const f of t.fields) {
      if (f.type !== 'ref' || !f.refTable) continue;
      if (f.refTable === to) out.push([...acc, f]); else rec(f.refTable, [...acc, f]);
    }
  };
  rec(from, []);
  const min = Math.min(...out.map(p => p.length));
  return out.filter(p => p.length === min);
}
