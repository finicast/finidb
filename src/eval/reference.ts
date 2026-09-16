/**
 * The reference evaluator (doc 05 §12.1): no incremental state, full recompute after any write,
 * memoised within a version. Obviously correct; the oracle for the fast engine.
 */
import { Database, Model, Table, Pivot, Field, Dim, Measure, AnyTable } from '../schema/schema.js';
import type { Rule } from '../schema/rules.js';
import type { Node, Selector, Bound } from '../lang/ast.js';
import { Value, Scalar, CellError, isError, RefColumn, toDays as require_toDays } from '../store/column.js';
import { FUNCTIONS, num, str, eq, cmp, truthy, err } from './functions.js';

export type Ctx =
  | { kind: 'pivot'; pivot: Pivot; coord: Int32Array }
  | { kind: 'row'; table: Table; row: number };

const AGG = new Set(['SUM', 'AVG', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTD', 'MIN', 'MAX', 'MEDIAN', 'FIRST', 'LAST', 'LISTAGG']);
const TIME_SUGAR = new Set(['PREV', 'NEXT', 'CUMSUM', 'TRAILING']);

/** A resolved reference: either a scalar location or a set to enumerate. */
type Resolved =
  | { k: 'cells'; pivot: Pivot; measure: Measure; sets: (number[] | 'all')[]; path: string[] }
  | { k: 'rows'; table: Table; field: Field; rows: number[] | 'all'; pinned: boolean; key: string; corr: Corr[]; filters: ((r: number) => boolean)[]; path: string[] }
  | { k: 'value'; v: Value }
  | { k: 'member'; dim: Dim; idx: number; path: string[] }       // a dimension member (id) with optional attribute path
  | { k: 'rowref'; table: Table; row: number; path: string[] };  // a row of a table (from a ref) with a path to follow

export class CompileError extends Error {
  /** the message without the code prefix */
  detail: string;
  constructor(public code: string, msg: string, public fix?: string) { super(`${code}: ${msg}`); this.detail = msg; }
}

export interface Corr {
  rowKey: (r: number) => string; ctxKey: string;
  /** integer form when the correlation is a ref path to a dimension member: rowIdx(r) ∈ [-1, radix) and ctxIdx */
  rowIdx?: (r: number) => number; ctxIdx?: number; radix?: number;
}
export type RowsRes = Extract<Resolved, { k: 'rows' }>;

export type Static =
  | { k: 'pivot'; pivot: Pivot; measure: Measure; implicit: Selector[]; path: string[] }
  | { k: 'member'; pivot: Pivot; dim: Dim; path: string[] }
  | { k: 'row' }
  | { k: 'field'; table: Table; field: Field; path: string[] }
  | { k: 'rows'; table: Table; field: Field; path: string[] };

/** Shared evaluation semantics. Storage (memo vs dense incremental) is supplied by subclasses. */
export abstract class EvalCore {
  /** cost counters for tests */
  counters = { cellsEvaluated: 0, rowsScanned: 0 };
  constructor(public db: Database) {}

  /** Value of a pivot cell (input, or governing rule, or blank). */
  abstract cell(pivot: Pivot, measure: Measure, coord: Int32Array): Value;
  /** Value of a table field at a row (base column or computed). */
  abstract field(table: Table, field: Field, row: number): Value;
  /** Aggregate a correlated rows-set for the current cell. */
  protected abstract aggregateRows(fn: string, res: RowsRes, ctx: Ctx): Value;

  /** Compute a pivot cell from scratch (no memo): input → governing rule → blank. */
  protected computeCell(pivot: Pivot, measure: Measure, coord: Int32Array): Value {
    const input = pivot.getInput(measure, coord);
    if (input !== undefined) return input;
    const ctx: Ctx = { kind: 'pivot', pivot, coord };
    const rule = this.governingRule(pivot.rules, measure.id, ctx);
    this.counters.cellsEvaluated++;
    return rule ? this.evalRule(rule, ctx) : null;
  }
  /** Compute a computed field from scratch (no memo). */
  protected computeField(table: Table, field: Field, row: number): Value {
    const ctx: Ctx = { kind: 'row', table, row };
    const rule = this.governingRule(table.rules, field.id, ctx);
    let v = rule ? this.evalRule(rule, ctx) : null;
    if (field.type === 'ref' && typeof v === 'string') { const r = field.refTable!.memberIndex(v); v = r < 0 ? err('REF', `no member ${v}`) : r; }
    this.counters.cellsEvaluated++;
    return v;
  }
  /** Bucket a rows-set by its correlation keys (full scan). Shared by both engines as the rescan path. */
  protected scanBuckets(res: RowsRes): Map<string, Value[]> {
    const buckets = new Map<string, Value[]>();
    const n = res.table.rowCount;
    for (let r = 0; r < n; r++) {
      this.counters.rowsScanned++;
      if (!res.filters.every(f => f(r))) continue;
      let bk = '';
      for (const c of res.corr) bk += c.rowKey(r) + '\u0001';
      let arr = buckets.get(bk);
      if (!arr) { arr = []; buckets.set(bk, arr); }
      arr.push(this.rowFieldValue(res, r));
    }
    return buckets;
  }
  /** Called when a rule reads another row of its own table ([row±n], [row=…]); subclasses may disable partial recompute. */
  protected noteRowShift(_t: Table): void {}
  protected ctxBucketKey(res: RowsRes): string { let ck = ''; for (const c of res.corr) ck += c.ctxKey + '\u0001'; return ck; }

  // ---------- rules ----------

  governingRule(rules: Rule[], target: string, ctx: Ctx): Rule | undefined {
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.target !== target || r.status !== 'ok' || !r.ast) continue;
      if (this.whenMatches(r.when, ctx)) return r;
    }
    return undefined;
  }

  whenMatches(when: import('../schema/rules.js').Clause[], ctx: Ctx): boolean {
    for (const c of when) {
      const left = this.leftValue(c.left, ctx);
      if (isError(left)) return false;
      const rights = Array.isArray(c.right) ? c.right : [c.right];
      switch (c.op) {
        case '=': if (!rights.some(r => this.memberEq(left, r))) return false; break;
        case '!=': if (rights.some(r => this.memberEq(left, r))) return false; break;
        case 'in': if (!rights.some(r => this.memberEq(left, r))) return false; break;
        case 'not in': if (rights.some(r => this.memberEq(left, r))) return false; break;
        default: { const x = cmp(left, rights[0] as Scalar); if (isError(x)) return false; if (c.op === '<' && !(x < 0)) return false; if (c.op === '<=' && !(x <= 0)) return false; if (c.op === '>' && !(x > 0)) return false; if (c.op === '>=' && !(x >= 0)) return false; }
      }
    }
    return true;
  }
  private memberEq(left: Value, right: string | number | boolean): boolean {
    return eq(left, right as Scalar);
  }
  /** Value of a condition's left side (dim member id, attribute, or field) at ctx. */
  protected leftValue(left: string, ctx: Ctx): Value {
    const path = left.split('.');
    if (ctx.kind === 'pivot') {
      const dim = ctx.pivot.dim(path[0]);
      if (dim) {
        const idx = ctx.coord[ctx.pivot.dimIndex(dim)];
        if (path.length === 1) return dim.table.rowId(idx);
        return this.followPath(dim.table, idx, path.slice(1));
      }
      // bare attribute name: unique across dims
      const found = this.findAttribute(ctx.pivot, path[0]);
      if (found) return this.followPath(found.dim.table, ctx.coord[ctx.pivot.dimIndex(found.dim)], path);
      return err('REF', `unknown condition field ${left}`);
    }
    const f = ctx.table.hasField(path[0]) ? ctx.table.field(path[0]) : undefined;
    if (!f) return err('REF', `unknown field ${left}`);
    const v = this.field(ctx.table, f, ctx.row);
    if (path.length === 1) return f.type === 'ref' && typeof v === 'number' ? f.refTable!.rowId(v) : v;
    if (f.type !== 'ref' || typeof v !== 'number') return err('REF', `${path[0]} is not a reference`);
    return this.followPath(f.refTable!, v, path.slice(1));
  }

  protected findAttribute(pivot: Pivot, name: string): { dim: Dim; field: Field } | undefined {
    let found: { dim: Dim; field: Field } | undefined;
    for (const d of pivot.dims) {
      if (d.table.hasField(name) && name !== 'id') {
        if (found) throw new CompileError('AMBIGUOUS_ATTRIBUTE', `'${name}' is an attribute of both ${found.dim.id} and ${d.id}; write ${found.dim.id}.${name} or ${d.id}.${name}`);
        found = { dim: d, field: d.table.field(name) };
      }
    }
    return found;
  }

  /** Follow a path of field names from a row of a table. Refs are followed; the final value is returned (ref → id string). */
  followPath(table: Table, row: number, path: string[]): Value {
    let t: Table = table; let r = row;
    for (let i = 0; i < path.length; i++) {
      if (r < 0) return null;
      const f = t.field(path[i]);
      const v = this.field(t, f, r);
      if (isError(v)) return v;
      if (i === path.length - 1) return f.type === 'ref' ? (typeof v === 'number' ? f.refTable!.rowId(v) : null) : v;
      if (f.type !== 'ref') throw new CompileError('BAD_PATH', `${t.id}.${f.id} is not a reference; cannot follow .${path[i + 1]}`);
      if (v === null) return null;
      t = f.refTable!; r = v as number;
    }
    return null;
  }

  evalRule(rule: Rule, ctx: Ctx): Value {
    try { return this.evalNode(rule.ast!, ctx); }
    catch (e) { if (e instanceof CompileError) { const x = err(e.code, e.detail); if (e.fix) x.fix = e.fix; return x; } throw e; }
  }

  // ---------- expressions ----------

  evalNode(n: Node, ctx: Ctx): Value {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'blank': return null;
      case 'un': {
        const v = this.evalNode(n.e, ctx);
        if (isError(v)) return v;
        if (n.op === '-') { const x = num(v); return isError(x) ? x : -x; }
        return !truthy(v);
      }
      case 'bin': return this.evalBin(n, ctx);
      case 'at': return this.evalAt(n.path, ctx);
      case 'ref': return this.evalRef(n, ctx);
      case 'call': return this.evalCall(n, ctx);
    }
  }

  private evalBin(n: Extract<Node, { k: 'bin' }>, ctx: Ctx): Value {
    if (n.op === 'and') { const l = this.evalNode(n.l, ctx); if (isError(l)) return l; if (!truthy(l)) return false; const r = this.evalNode(n.r, ctx); return isError(r) ? r : truthy(r); }
    if (n.op === 'or') { const l = this.evalNode(n.l, ctx); if (isError(l)) return l; if (truthy(l)) return true; const r = this.evalNode(n.r, ctx); return isError(r) ? r : truthy(r); }
    const l = this.evalNode(n.l, ctx); if (isError(l)) return l;
    const r = this.evalNode(n.r, ctx); if (isError(r)) return r;
    switch (n.op) {
      case '=': return eq(l, r);
      case '!=': return !eq(l, r);
      case '<': case '<=': case '>': case '>=': { const c = cmp(l, r); if (isError(c)) return c; return n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0; }
      case '&': { const a = str(l), b = str(r); if (isError(a)) return a; if (isError(b)) return b; return a + b; }
      default: {
        const a = num(l), b = num(r); if (isError(a)) return a; if (isError(b)) return b;
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b === 0 ? err('DIV0') : a / b;
          case '^': return Math.pow(a, b);
        }
      }
    }
    return err('OP', n.op);
  }

  protected evalAt(path: string[], ctx: Ctx): Value {
    if (ctx.kind === 'pivot') {
      const dim = ctx.pivot.dim(path[0]);
      if (!dim) throw new CompileError('UNKNOWN_DIM', `@${path[0]} is not a dimension of ${ctx.pivot.id}`);
      const idx = ctx.coord[ctx.pivot.dimIndex(dim)];
      return path.length === 1 ? dim.table.rowId(idx) : this.followPath(dim.table, idx, path.slice(1));
    }
    if (path[0] === 'row') return ctx.row;
    const f = ctx.table.field(path[0]);
    const v = this.field(ctx.table, f, ctx.row);
    if (isError(v)) return v;
    if (path.length === 1) return f.type === 'ref' ? (typeof v === 'number' ? f.refTable!.rowId(v) : null) : v;
    if (f.type !== 'ref') throw new CompileError('BAD_PATH', `${f.id} is not a reference`);
    return v === null ? null : this.followPath(f.refTable!, v as number, path.slice(1));
  }

  private evalCall(n: Extract<Node, { k: 'call' }>, ctx: Ctx): Value {
    const name = n.name;
    if (name === 'IF') {
      const c = this.evalNode(n.args[0], ctx); if (isError(c)) return c;
      if (truthy(c)) return n.args.length > 1 ? this.evalNode(n.args[1], ctx) : true;
      return n.args.length > 2 ? this.evalNode(n.args[2], ctx) : 0;
    }
    if (name === 'AND') { for (const a of n.args) { const v = this.evalNode(a, ctx); if (isError(v)) return v; if (!truthy(v)) return false; } return true; }
    if (name === 'OR') { for (const a of n.args) { const v = this.evalNode(a, ctx); if (isError(v)) return v; if (truthy(v)) return true; } return false; }
    if (name === 'IFERROR') { const v = this.evalNode(n.args[0], ctx); return isError(v) ? this.evalNode(n.args[1], ctx) : v; }
    if (TIME_SUGAR.has(name)) return this.evalTimeSugar(n, ctx);
    if (name === 'PERIOD') return this.evalPeriod(n, ctx);
    if (AGG.has(name)) {
      if (n.args.length === 1 && n.args[0].k === 'ref') {
        const res = this.resolve(n.args[0], ctx, true);
        if (res.k === 'rows' && res.corr.length) return this.aggregateRows(name, res, ctx);
      }
      // Expand set arguments; scalar args pass through.
      const flat: Value[] = [];
      for (const a of n.args) {
        if (a.k === 'ref') {
          const res = this.resolve(a, ctx, true);
          if (res.k === 'cells' || res.k === 'rows') { flat.push(...this.enumerate(res, ctx)); continue; }
          flat.push(this.valueOf(res, ctx));
        } else flat.push(this.evalNode(a, ctx));
      }
      for (const v of flat) if (isError(v)) return v;
      if ((name === 'FIRST' || name === 'LAST') && n.args.length === 1 && n.args[0].k === 'ref' && ctx.kind === 'pivot') {
        const res = this.resolve(n.args[0], ctx, true);
        if (res.k === 'cells' && res.sets.every(s => s !== 'all' && s.length === 1)) {
          // scalar: time sugar x[time=first|last]
          return this.timeShift(n.args[0], ctx, name === 'FIRST' ? 'first' : 'last');
        }
      }
      return FUNCTIONS[name](flat);
    }
    const fn = FUNCTIONS[name];
    if (!fn) throw new CompileError('UNKNOWN_FUNCTION', `Unknown function ${name}`);
    const args = n.args.map(a => this.evalNode(a, ctx));
    for (const v of args) if (isError(v)) return v;
    return fn(args);
  }

  /** PERIOD(date[, periods]) → the id of the period whose [start, end] contains the date (doc 04 §6). */
  private periodStarts = new Map<Table, { version: number; starts: Int32Array; ends: Int32Array; order: Int32Array }>();
  private evalPeriod(n: Extract<Node, { k: 'call' }>, ctx: Ctx): Value {
    const d = this.evalNode(n.args[0], ctx);
    if (isError(d)) return d;
    if (d === null || d === '') return null;
    let table: Table | undefined;
    if (n.args.length > 1) {
      const a = n.args[1];
      if (a.k !== 'ref' || a.parts.length !== 1) throw new CompileError('BAD_ARG', 'PERIOD takes a periods table as its second argument');
      const model = ctx.kind === 'pivot' ? ctx.pivot.model : ctx.table.model;
      const t = model.table(a.parts[0]);
      if (t.kind !== 'tabular') throw new CompileError('BAD_ARG', `${a.parts[0]} is not a table`);
      table = t;
    } else if (ctx.kind === 'pivot') table = ctx.pivot.timeDim?.table;
    else {
      const cands = ctx.table.fields.filter(f => f.type === 'ref' && f.refTable!.hasField('start') && f.refTable!.hasField('end')).map(f => f.refTable!);
      table = cands[0];
      if (!table) for (const t of ctx.table.model.tables.values()) if (t.kind === 'tabular' && t.hasField('start') && t.hasField('end') && t.hasField('frame')) { table = t; break; }
    }
    if (!table) throw new CompileError('NO_PERIODS', 'PERIOD needs a periods table with start and end columns; pass it as the second argument');
    const days = typeof d === 'number' ? Math.floor(d) : (() => { const x = require_toDays(d as string); return x; })();
    if (days === null) return err('TYPE', 'PERIOD expects a date');
    let idx = this.periodStarts.get(table);
    const ver = table.version + table.field('start').column.version + table.field('end').column.version;
    if (!idx || idx.version !== ver) {
      const n = table.rowCount;
      const starts = new Int32Array(n), ends = new Int32Array(n);
      const sc = table.field('start').column, ec = table.field('end').column;
      for (let i = 0; i < n; i++) { const a = sc.get(i), b = ec.get(i); starts[i] = a === null ? 0x7fffffff : Number(a); ends[i] = b === null ? 0x7fffffff : Number(b); }
      const order = new Int32Array(n); for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => starts[a] - starts[b]);
      idx = { version: ver, starts, ends, order };
      this.periodStarts.set(table, idx);
    }
    // binary search the last period whose start <= days, then check end
    let lo = 0, hi = idx.order.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const i = idx.order[mid]; if (idx.starts[i] <= days) { found = i; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0 || idx.ends[found] < days) return null;
    return table.rowId(found);
  }

  private timeDimOf(ctx: Ctx): Dim {
    if (ctx.kind !== 'pivot') throw new CompileError('NO_TIME_DIM', 'PREV/NEXT need a pivot with a time dimension');
    const d = ctx.pivot.timeDim ?? (ctx.pivot.dims.length === 1 ? ctx.pivot.dims[0] : undefined);
    if (!d) throw new CompileError('NO_TIME_DIM', `${ctx.pivot.id} has no time dimension; set timeDim or use [dim-1]`);
    return d;
  }
  private timeShift(refNode: Node, ctx: Ctx, mode: 'first' | 'last' | number): Value {
    if (refNode.k !== 'ref') throw new CompileError('BAD_ARG', 'PREV/NEXT/FIRST/LAST take a reference');
    const t = this.timeDimOf(ctx);
    const sel: Selector = typeof mode === 'number' ? { k: 'offset', dim: t.id, by: mode } : { k: 'eq', path: [t.id], op: '=', value: { k: 'kw', v: mode } };
    const shifted: Node = { ...refNode, selectors: [...refNode.selectors, sel] };
    return this.evalRef(shifted, ctx);
  }
  private evalTimeSugar(n: Extract<Node, { k: 'call' }>, ctx: Ctx): Value {
    const t = this.timeDimOf(ctx);
    const ref = n.args[0];
    if (!ref || ref.k !== 'ref') throw new CompileError('BAD_ARG', `${n.name} takes a reference`);
    if (n.name === 'PREV' || n.name === 'NEXT') {
      const k = n.args.length > 1 ? num(this.evalNode(n.args[1], ctx)) : 1;
      if (isError(k)) return k;
      return this.timeShift(ref, ctx, n.name === 'PREV' ? -k : k);
    }
    if (n.name === 'CUMSUM') {
      const sel: Selector = { k: 'range', path: [t.id], from: { k: 'kw', v: 'first' }, to: { k: 'kw', v: 'this' } };
      const res = this.resolve({ ...ref, selectors: [...ref.selectors, sel] }, ctx, true);
      const vals = res.k === 'cells' ? this.enumerate(res, ctx) : [this.valueOf(res, ctx)];
      for (const v of vals) if (isError(v)) return v;
      return FUNCTIONS.SUM(vals);
    }
    // TRAILING(x, n, AGG)
    const k = num(this.evalNode(n.args[1], ctx)); if (isError(k)) return k;
    const agg = n.args[2]?.k === 'ref' ? n.args[2].parts[0].toUpperCase() : 'AVG';
    const sel: Selector = { k: 'range', path: [t.id], from: { k: 'kw', v: 'this', by: -(k - 1) }, to: { k: 'kw', v: 'this' } };
    const res = this.resolve({ ...ref, selectors: [...ref.selectors, sel] }, ctx, true);
    const vals = res.k === 'cells' ? this.enumerate(res, ctx) : [this.valueOf(res, ctx)];
    for (const v of vals) if (isError(v)) return v;
    return FUNCTIONS[agg](vals);
  }

  // ---------- references ----------

  protected evalRef(n: Extract<Node, { k: 'ref' }>, ctx: Ctx): Value {
    const res = this.resolve(n, ctx, false);
    return this.valueOf(res, ctx);
  }

  protected valueOf(res: Resolved, ctx: Ctx): Value {
    switch (res.k) {
      case 'value': return res.v;
      case 'member': return res.path.length ? this.followPath(res.dim.table, res.idx, res.path) : res.dim.table.rowId(res.idx);
      case 'rowref': return res.path.length ? this.followPath(res.table, res.row, res.path) : res.table.rowId(res.row);
      case 'cells': {
        if (res.sets.some(s => s !== 'all' && s.length === 0)) return null;
        if (res.sets.some(s => s === 'all' || s.length !== 1)) throw new CompileError('SET_IN_SCALAR', `${res.pivot.id}.${res.measure.id} refers to many cells here; wrap it in SUM(), AVG(), … or pin every dimension`);
        const coord = new Int32Array(res.sets.map(s => (s as number[])[0]));
        const v = this.cell(res.pivot, res.measure, coord);
        if (res.path.length) { if (typeof v !== 'string') return err('REF', 'path on a non-member value'); return err('REF', 'path on a measure value is not supported'); }
        return v;
      }
      case 'rows': {
        const rows = this.rowsOf(res, ctx);
        if (rows.length === 0 && res.pinned) return null;
        if (rows.length !== 1) throw new CompileError('SET_IN_SCALAR', `${res.table.id}.${res.field.id} refers to ${rows.length} rows here; wrap it in an aggregate or pin the row with [id=…]`);
        return this.rowFieldValue(res, rows[0]);
      }
    }
  }

  protected rowFieldValue(res: Extract<Resolved, { k: 'rows' }>, r: number): Value {
    const v = this.field(res.table, res.field, r);
    if (isError(v)) return v;
    if (res.path.length) {
      if (res.field.type !== 'ref' || typeof v !== 'number') throw new CompileError('BAD_PATH', `${res.field.id} is not a reference`);
      return this.followPath(res.field.refTable!, v, res.path);
    }
    return res.field.type === 'ref' ? (typeof v === 'number' ? res.field.refTable!.rowId(v) : null) : v;
  }

  /** Enumerate a set reference into values. */
  protected enumerate(res: Resolved, ctx: Ctx): Value[] {
    if (res.k === 'cells') {
      const out: Value[] = [];
      const lists = res.sets.map((s, i) => s === 'all' ? range(res.pivot.dims[i].table.rowCount) : s);
      const coord = new Int32Array(lists.length);
      const rec = (d: number) => {
        if (d === lists.length) { out.push(this.cell(res.pivot, res.measure, coord)); return; }
        for (const m of lists[d]) { coord[d] = m; rec(d + 1); }
      };
      rec(0);
      return out;
    }
    if (res.k === 'rows') return this.rowsOf(res, ctx).map(r => this.rowFieldValue(res, r));
    return [this.valueOf(res, ctx)];
  }
  protected rowsOf(res: Extract<Resolved, { k: 'rows' }>, _ctx: Ctx): number[] {
    const out: number[] = [];
    const n = res.table.rowCount;
    let ck = ''; for (const c of res.corr) ck += c.ctxKey + '\u0001';
    for (let r = 0; r < n; r++) {
      this.counters.rowsScanned++;
      if (!res.filters.every(f => f(r))) continue;
      if (res.corr.length) { let bk = ''; for (const c of res.corr) bk += c.rowKey(r) + '\u0001'; if (bk !== ck) continue; }
      out.push(r);
    }
    return out;
  }

  /** Resolve a reference node against a context. */
  /** Static classification of a reference: which object a name denotes. Cached on the node per schema version and context. */
  classifyRef(n: Extract<Node, { k: 'ref' }>, ctx: Ctx): Static {
    const ctxIid = ctx.kind === 'pivot' ? ctx.pivot.iid : ctx.table.iid;
    const lineVer = ctx.kind === 'pivot' && ctx.pivot.lineDim ? ctx.pivot.lineDim.table.version : 0;
    const cache = (n as any)._st as { sv: number; iid: number; lv: number; res: Static } | undefined;
    if (cache && cache.sv === this.db.schemaVersion && cache.iid === ctxIid && cache.lv === lineVer) return cache.res;
    const res = this.classifyUncached(n, ctx);
    (n as any)._st = { sv: this.db.schemaVersion, iid: ctxIid, lv: lineVer, res };
    return res;
  }
  private classifyUncached(n: Extract<Node, { k: 'ref' }>, ctx: Ctx): Static {
    const model = ctx.kind === 'pivot' ? ctx.pivot.model : ctx.table.model;
    let parts = n.parts.slice();
    let target: AnyTable | undefined;
    if (parts.length >= 3 && this.db.models.has(parts[0]) && this.db.model(parts[0]).hasTable(parts[1])) { target = this.db.model(parts[0]).table(parts[1]); parts = parts.slice(2); }
    else if (parts.length >= 2 && model.hasTable(parts[0]) && !this.isLocalName(parts[0], ctx)) { target = model.table(parts[0]); parts = parts.slice(1); }
    const name = parts[0];
    const path = [...parts.slice(1), ...n.path];
    if (!target) {
      if (ctx.kind === 'pivot') {
        const p = ctx.pivot;
        const m = p.measure(name);
        if (m) return { k: 'pivot', pivot: p, measure: m, implicit: [], path };
        if (p.lineDim && p.lineDim.table.memberIndex(name) >= 0) return { k: 'pivot', pivot: p, measure: p.defaultMeasure, implicit: [{ k: 'eq', path: [p.lineDim.id], op: '=', value: { k: 'member', v: name } }], path };
        const dim = p.dim(name);
        if (dim) { if (n.selectors.length) throw new CompileError('BAD_REF', `a dimension takes no selector`); return { k: 'member', pivot: p, dim, path }; }
        const attr = this.findAttribute(p, name);
        if (attr) return { k: 'member', pivot: p, dim: attr.dim, path: [name, ...path] };
        throw new CompileError('UNKNOWN_NAME', `'${name}' is not a measure, line item, dimension or attribute of ${p.id}`, p.lineDim ? `did you mean a member of ${p.lineDim.id}?` : undefined);
      }
      const t = ctx.table;
      if (name === 'row') return { k: 'row' };
      if (!t.hasField(name)) throw new CompileError('UNKNOWN_NAME', `'${name}' is not a field of ${t.id}`);
      const f = t.field(name);
      if (n.selectors.length) return { k: 'rows', table: t, field: f, path };
      if (f.type !== 'ref' && path.length) throw new CompileError('BAD_PATH', `${f.id} is not a reference`);
      return { k: 'field', table: t, field: f, path };
    }
    if (target.kind === 'pivot') {
      const m = target.measure(name);
      if (m) return { k: 'pivot', pivot: target, measure: m, implicit: [], path };
      if (target.lineDim && target.lineDim.table.memberIndex(name) >= 0) return { k: 'pivot', pivot: target, measure: target.defaultMeasure, implicit: [{ k: 'eq', path: [target.lineDim.id], op: '=', value: { k: 'member', v: name } }], path };
      throw new CompileError('UNKNOWN_NAME', `'${name}' is not a measure or line item of ${target.id}`);
    }
    if (!target.hasField(name)) throw new CompileError('UNKNOWN_NAME', `'${name}' is not a field of ${target.id}`);
    return { k: 'rows', table: target, field: target.field(name), path };
  }

  resolve(n: Extract<Node, { k: 'ref' }>, ctx: Ctx, inAggregate: boolean): Resolved {
    const st = this.classifyRef(n, ctx);
    switch (st.k) {
      case 'pivot': return this.pivotCells(st.pivot, st.measure, n.selectors, st.implicit, ctx, inAggregate, st.path);
      case 'member': return { k: 'member', dim: st.dim, idx: (ctx as Extract<Ctx, { kind: 'pivot' }>).coord[st.pivot.dimIndex(st.dim)], path: st.path };
      case 'row': return { k: 'value', v: (ctx as Extract<Ctx, { kind: 'row' }>).row };
      case 'field': {
        const rc = ctx as Extract<Ctx, { kind: 'row' }>;
        const v = this.field(st.table, st.field, rc.row);
        if (isError(v)) return { k: 'value', v };
        if (st.field.type === 'ref') return v === null ? { k: 'value', v: null } : { k: 'rowref', table: st.field.refTable!, row: v as number, path: st.path };
        return { k: 'value', v };
      }
      case 'rows': return this.tableRows(st.table, st.field, n.selectors, ctx, st.path, n.text);
    }
  }


  private isLocalName(name: string, ctx: Ctx): boolean {
    if (ctx.kind === 'row') return ctx.table.hasField(name);
    return !!(ctx.pivot.measure(name) || ctx.pivot.dim(name) || (ctx.pivot.lineDim && ctx.pivot.lineDim.table.memberIndex(name) >= 0));
  }

  /** Build the per-dimension member sets for a pivot reference. */
  protected pivotCells(p: Pivot, m: Measure, selectors: Selector[], implicit: Selector[], ctx: Ctx, inAggregate: boolean, path: string[]): Resolved {
    const sets: (number[] | 'all')[] = [];
    // defaults
    for (const d of p.dims) {
      let cur: number | undefined;
      if (ctx.kind === 'pivot') {
        // same pivot: the dimension itself; another pivot: same id over the same table, else the same table
        const same = ctx.pivot === p ? d : (ctx.pivot.dims.find(x => x.id === d.id && x.table === d.table) ?? ctx.pivot.dims.find(x => x.table === d.table));
        if (same) cur = ctx.coord[ctx.pivot.dimIndex(same)];
      } else {
        const refs = ctx.table.fields.filter(f => f.type === 'ref' && f.refTable === d.table);
        if (refs.length === 1) { const v = this.field(ctx.table, refs[0], ctx.row); if (typeof v === 'number') cur = v; else cur = -1; }
      }
      if (cur !== undefined) sets.push(cur < 0 ? [] : [cur]);
      else if (inAggregate) sets.push('all');
      else sets.push('all'); // decided below: error if still 'all' in scalar position
    }
    const all = [...implicit, ...selectors];
    const defaults = sets.slice();
    const touched = new Set<number>();
    for (const s of all) {
      const dimName = (s.k === 'offset') ? s.dim : s.path[0];
      const d = p.dim(dimName);
      if (!d) throw new CompileError('UNKNOWN_DIM', `'${dimName}' is not a dimension of ${p.id}`);
      const di = p.dimIndex(d);
      const n = d.table.rowCount;
      const current = () => {
        const c = defaults[di];
        if (c === 'all' || c.length !== 1) throw new CompileError('NO_CURRENT', `'${d.id}' has no current member in this context; pin it explicitly`);
        return c[0];
      };
      // an explicit selector on a dim replaces the default; several selectors on the same dim intersect
      const isFilter = (s.k === 'eq' && s.path.length > 1) || s.k === 'cmp' || (s.k === 'corr' && s.path.length > 1) || (s.k === 'in' && s.path.length > 1) || (s.k === 'eq' && s.op === '!=');
      if (isFilter && !touched.has(di)) sets[di] = 'all';
      touched.add(di);
      const attrPath = s.k === 'offset' ? [] : s.path.slice(1);
      switch (s.k) {
        case 'offset': { const c = current() + s.by; sets[di] = c >= 0 && c < n ? [c] : []; break; }
        case 'eq': {
          if (attrPath.length === 0) {
            if (s.value.k === 'kw') {
              const kw = s.value.v;
              if (kw === 'all') sets[di] = 'all';
              else if (kw === 'first') sets[di] = n ? [0] : [];
              else if (kw === 'last') sets[di] = n ? [n - 1] : [];
              else sets[di] = [current()];
              if (s.op === '!=') sets[di] = complement(sets[di], n);
            } else {
              const idx = d.table.memberIndex(String(s.value.v));
              if (idx < 0) throw new CompileError('NO_MEMBER', `'${s.value.v}' is not a member of ${d.id} (${d.table.id})`);
              sets[di] = s.op === '=' ? [idx] : complement([idx], n);
            }
          } else {
            const want = s.value.k === 'kw' ? null : s.value.v;
            if (want === null) throw new CompileError('BAD_SELECTOR', 'attribute selectors take a literal');
            const members = range(n).filter(i => eq(this.followPath(d.table, i, attrPath), want as Scalar) === (s.op === '='));
            sets[di] = intersect(sets[di], members, n);
          }
          break;
        }
        case 'in': {
          let members: number[];
          if (attrPath.length === 0) members = s.values.map(v => { const i = d.table.memberIndex(String(v)); if (i < 0) throw new CompileError('NO_MEMBER', `'${v}' is not a member of ${d.id}`); return i; });
          else members = range(n).filter(i => s.values.some(v => eq(this.followPath(d.table, i, attrPath), v)));
          sets[di] = s.not ? complement(members, n) : members;
          break;
        }
        case 'cmp': {
          const members = range(n).filter(i => {
            const v = attrPath.length ? this.followPath(d.table, i, attrPath) : d.table.rowId(i);
            const c = cmp(v, s.value as Scalar); if (isError(c)) return false;
            return s.op === '<' ? c < 0 : s.op === '<=' ? c <= 0 : s.op === '>' ? c > 0 : c >= 0;
          });
          sets[di] = intersect(sets[di], members, n);
          break;
        }
        case 'range': {
          const b = (x: Bound): number => {
            if (x.k === 'kw') { if (x.v === 'first') return 0; if (x.v === 'last') return n - 1; return current() + (x.by ?? 0); }
            const i = d.table.memberIndex(String(x.v)); if (i < 0) throw new CompileError('NO_MEMBER', `'${x.v}' is not a member of ${d.id}`); return i;
          };
          const lo = Math.max(0, b(s.from)), hi = Math.min(n - 1, b(s.to));
          sets[di] = lo <= hi ? range(hi - lo + 1).map(i => i + lo) : [];
          break;
        }
        case 'corr': {
          const rv = this.evalAt(s.right, ctx); // ctx-side value (member id string or attribute value)
          if (isError(rv)) return { k: 'value', v: rv };
          if (attrPath.length === 0) { const i = rv === null ? -1 : d.table.memberIndex(String(rv)); sets[di] = i < 0 ? [] : [i]; }
          else sets[di] = intersect(sets[di], range(n).filter(i => eq(this.followPath(d.table, i, attrPath), rv as Scalar)), n);
          break;
        }
      }
    }
    if (!inAggregate) {
      const bad = sets.findIndex(s => s === 'all');
      if (bad >= 0) throw new CompileError('UNPINNED_DIM', `${p.id}.${m.id} needs a member for dimension '${p.dims[bad].id}' here; pin it, e.g. [${p.dims[bad].id}=…]`);
    }
    return { k: 'cells', pivot: p, measure: m, sets, path };
  }

  /** Build a rows set for a tabular column reference with selectors and inferred correlations. */
  protected tableRows(t: Table, f: Field, selectors: Selector[], ctx: Ctx, path: string[], key = ''): Resolved {
    let pinned = false;
    const filters: ((r: number) => boolean)[] = [];
    const corr: Corr[] = [];
    const explicitCorr = new Set<Table>();
    let rows: number[] | 'all' = 'all';
    for (const s of selectors) {
      if (s.k === 'offset') {
        if (s.dim !== 'row') throw new CompileError('BAD_SELECTOR', `offsets on a table use [row±n]`);
        if (ctx.kind !== 'row' || ctx.table !== t) throw new CompileError('BAD_SELECTOR', '[row±n] is only valid within the same table');
        this.noteRowShift(t);
        const r = ctx.row + s.by; rows = r >= 0 && r < t.rowCount ? [r] : []; pinned = true;
        continue;
      }
      const p = s.path;
      if (p[0] === 'row') {
        this.noteRowShift(t);
        pinned = s.k === 'eq';
        if (s.k === 'eq' && s.value.k === 'kw') { if (s.value.v === 'first') rows = [0]; else if (s.value.v === 'last') rows = [t.rowCount - 1]; else if (s.value.v === 'this') rows = ctx.kind === 'row' ? [ctx.row] : []; }
        else if (s.k === 'range') { const b = (x: Bound) => x.k === 'kw' ? (x.v === 'first' ? 0 : x.v === 'last' ? t.rowCount - 1 : (ctx.kind === 'row' ? ctx.row : 0) + (x.by ?? 0)) : Number(x.v); const lo = Math.max(0, b(s.from)), hi = Math.min(t.rowCount - 1, b(s.to)); rows = lo <= hi ? range(hi - lo + 1).map(i => i + lo) : []; }
        continue;
      }
      const head = t.field(p[0]);
      const rest = p.slice(1);
      const rowVal = (r: number): Value => rest.length ? (head.type === 'ref' ? (() => { const v = this.field(t, head, r); return typeof v === 'number' ? this.followPath(head.refTable!, v, rest) : null; })() : err('REF', 'path on non-ref')) : (() => { const v = this.field(t, head, r); return head.type === 'ref' ? (typeof v === 'number' ? head.refTable!.rowId(v) : null) : v; })();
      switch (s.k) {
        case 'eq': {
          if (s.value.k === 'kw') throw new CompileError('BAD_SELECTOR', 'keywords are not valid on table fields');
          const want = s.value.v;
          if (p.length === 1 && head.id === 'id') { const r = t.memberIndex(String(want)); rows = r < 0 ? [] : [r]; pinned = true; break; }
          filters.push(r => eq(rowVal(r), want) === (s.op === '='));
          break;
        }
        case 'in': filters.push(r => s.values.some(v => eq(rowVal(r), v)) !== s.not); break;
        case 'cmp': filters.push(r => { const c = cmp(rowVal(r), s.value as Scalar); if (isError(c)) return false; return s.op === '<' ? c < 0 : s.op === '<=' ? c <= 0 : s.op === '>' ? c > 0 : c >= 0; }); break;
        case 'range': throw new CompileError('BAD_SELECTOR', 'ranges on table fields are not supported; use [row=a..b]');
        case 'corr': {
          const ctxVal = this.evalAt(s.right, ctx);
          if (isError(ctxVal)) return { k: 'value', v: ctxVal };
          const entry: Corr = { rowKey: r => keyOf(rowVal(r)), ctxKey: keyOf(ctxVal) };
          if (rest.length === 0 && head.type === 'ref' && ctx.kind === 'pivot' && s.right.length === 1) {
            const cd = ctx.pivot.dim(s.right[0]);
            if (cd && cd.table === head.refTable) {
              const col = head.column as import('../store/column.js').RefColumn;
              const computed = head.computed;
              entry.rowIdx = computed ? (r => { const v = this.field(t, head, r); return typeof v === 'number' ? v : -1; }) : (r => col.data[r]);
              entry.ctxIdx = ctx.coord[ctx.pivot.dimIndex(cd)]; entry.radix = cd.table.rowCount;
            }
          }
          corr.push(entry);
          // remember which target table this correlation covers so inference does not double it
          const covered = rest.length === 0 && head.type === 'ref' ? head.refTable : (rest.length && head.type === 'ref' ? this.pathTarget(head.refTable!, rest) : undefined);
          if (covered) explicitCorr.add(covered);
          break;
        }
      }
    }
    // inferred correlations: for each ctx pivot dim not explicitly correlated, find a unique ref path from t to the dim's table
    if (ctx.kind === 'pivot') {
      for (const d of ctx.pivot.dims) {
        if (explicitCorr.has(d.table) || d.table === t) continue;
        const paths = this.pathsTo(t, d.table, 2);
        if (paths.length > 1) {
          throw new CompileError('AMBIGUOUS_GROUP_KEY', `${t.id}.${f.id} can reach dimension '${d.id}' ${paths.length} ways: ${paths.map(p => p.map(x => x.id).join('.')).join(', ')}`,
            `${t.id}.${f.id}[${paths[0].map(x => x.id).join('.')}=@${d.id}]`);
        }
        if (paths.length === 1) {
          const pth = paths[0];
          const ctxIdx = ctx.coord[ctx.pivot.dimIndex(d)];
          const rowIdx = (r: number): number => { let tt: Table = t; let rr = r; for (const fld of pth) { const v = this.field(tt, fld, rr); if (typeof v !== 'number') return -1; tt = fld.refTable!; rr = v; } return rr; };
          corr.push({ rowKey: r => { const i = rowIdx(r); return i < 0 ? '\u0000' : String(i); }, ctxKey: String(ctxIdx), rowIdx, ctxIdx, radix: d.table.rowCount });
        }
      }
    }
    return { k: 'rows', table: t, field: f, rows, pinned, key, corr, filters: rows === 'all' ? filters : [(r: number) => (rows as number[]).includes(r), ...filters], path };
  }

  private pathTarget(t: Table, rest: string[]): Table | undefined {
    let cur = t;
    for (const name of rest) { const f = cur.field(name); if (f.type !== 'ref') return undefined; cur = f.refTable!; }
    return cur;
  }
  private pathCache = new Map<string, Field[][]>();
  private pathsTo(from: Table, to: Table, maxHops: number): Field[][] {
    const ck = `${from.iid}:${to.iid}:${maxHops}:${this.db.schemaVersion}`;
    const hit = this.pathCache.get(ck);
    if (hit) return hit;
    const r = this.pathsToUncached(from, to, maxHops);
    this.pathCache.set(ck, r);
    return r;
  }
  private pathsToUncached(from: Table, to: Table, maxHops: number): Field[][] {
    const out: Field[][] = [];
    const rec = (t: Table, acc: Field[]) => {
      if (acc.length >= maxHops) return;
      for (const f of t.fields) {
        if (f.type !== 'ref') continue;
        if (f.refTable === to) out.push([...acc, f]);
        else rec(f.refTable!, [...acc, f]);
      }
    };
    rec(from, []);
    // prefer shortest paths: if any 1-hop path exists, ignore longer ones
    const min = Math.min(...out.map(p => p.length));
    return out.filter(p => p.length === min);
  }
}

function range(n: number): number[] { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }
function complement(s: number[] | 'all', n: number): number[] { if (s === 'all') return []; const set = new Set(s); return range(n).filter(i => !set.has(i)); }
function intersect(a: number[] | 'all', b: number[], _n: number): number[] { if (a === 'all') return b; const set = new Set(a); return b.filter(i => set.has(i)); }
function keyOf(v: Value): string { if (v === null || v === undefined) return '\u0000'; if (isError(v)) return '\u0002'; return typeof v === 'string' ? v.toLowerCase() : String(v); }


/** Memo-per-version evaluator: full recompute after any write. */
export class ReferenceEvaluator extends EvalCore {
  private memo = new Map<string, Value>();
  private memoVersion = -1;
  private inProgress = new Set<string>();
  private bucketCache = new Map<string, Map<string, Value[]>>();

  private checkVersion() {
    if (this.memoVersion !== this.db.version) { this.memo.clear(); this.bucketCache.clear(); this.memoVersion = this.db.version; }
  }
  cell(pivot: Pivot, measure: Measure, coord: Int32Array): Value {
    this.checkVersion();
    const key = `p${pivot.iid}:${measure.iid}:${pivot.tupleKey(coord)}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    if (this.inProgress.has(key)) return err('CYCLE', `${pivot.id}.${measure.id} depends on itself`);
    this.inProgress.add(key);
    let v: Value;
    try { v = this.computeCell(pivot, measure, coord); } finally { this.inProgress.delete(key); }
    this.memo.set(key, v);
    return v;
  }
  field(table: Table, field: Field, row: number): Value {
    if (!field.computed) return field.column.get(row);
    this.checkVersion();
    const key = `t${table.iid}:${field.iid}:${row}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    if (this.inProgress.has(key)) return err('CYCLE', `${table.id}.${field.id} depends on itself`);
    this.inProgress.add(key);
    let v: Value;
    try { v = this.computeField(table, field, row); } finally { this.inProgress.delete(key); }
    this.memo.set(key, v);
    return v;
  }
  protected aggregateRows(fn: string, res: RowsRes, ctx: Ctx): Value {
    this.checkVersion();
    const key = `${res.table.iid}:${res.field.iid}:${res.key}:${ctx.kind === 'pivot' ? ctx.pivot.iid : ctx.table.iid}`;
    let buckets = this.bucketCache.get(key);
    if (!buckets) { buckets = this.scanBuckets(res); this.bucketCache.set(key, buckets); }
    const vals = buckets.get(this.ctxBucketKey(res)) ?? [];
    for (const v of vals) if (isError(v)) return v;
    return FUNCTIONS[fn](vals);
  }
}
