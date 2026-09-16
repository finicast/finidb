/**
 * The incremental engine (doc 05). Dense per-column storage, pull-based freshness with recorded
 * dependencies at column granularity, row-level dirty sets for tabular computed columns
 * (propagated through reference columns), and delta-maintained correlated aggregates.
 * Semantics come from EvalCore; only storage and scheduling live here. Verified against
 * ReferenceEvaluator by the differential test.
 */
import { Database, Table, Pivot, Field, Measure } from '../schema/schema.js';
import { Value, CellError, isError } from '../store/column.js';
import { EvalCore, Ctx, RowsRes } from './reference.js';
import { FUNCTIONS, num, err } from './functions.js';
import { compileRowRule, RowFn } from './compile.js';
import type { Rule } from '../schema/rules.js';

type Ver = number | string;
/** A dependency is a base Field, a computed column state, an aggregate state, or a named pseudo-key. */
type DepKey = Field | ColState | AggState | string;

interface Tracker { gen: number; deps: Map<DepKey, Ver> }
interface Snapshot { values: Float64Array; state: Uint8Array; other: Map<number, Value>; size: number; computedOnce: boolean; version: number }

interface ColState extends Tracker {
  kind: 'measure' | 'field';
  pivot?: Pivot; measure?: Measure; table?: Table; field?: Field;
  values: Float64Array;
  other: Map<number, Value>;      // strings, bools, errors
  state: Uint8Array;              // 0 not computed · 1 number · 2 other · 3 blank · 4 visiting
  size: number;
  version: number;
  computedOnce: boolean;
  checkedAt: number;
  computing: boolean;
  checking: boolean;
  noPartial: boolean;             // reads its own column or other rows → never partial
  dirtyRows: DirtyRows;
  _seen: number;
}

interface AggState extends Tracker {
  kind: 'agg';
  table: Table;
  fn: string;
  numeric: boolean;               // integer bucket ids (typed arrays) vs string keys
  // numeric form
  strides: number[]; nBuckets: number;
  sum: Float64Array; count: Int32Array; nonBlank: Int32Array; errors: Int32Array; firstError: Map<number, CellError>; text: Int32Array;   // count = numeric values, nonBlank = blanks, text = non-numeric non-blank
  rowBucket: Int32Array;          // -1 = filtered out
  rowVal: Float64Array; rowOther: Map<number, Value>; rowState: Uint8Array;   // 1 number · 2 other · 3 blank
  // string form
  sbuckets: Map<string, SBucket>;
  srowBucket: (string | null)[]; srowVal: Value[];
  keepVals: boolean;
  computedOnce: boolean;
  checkedAt: number;
  checking: boolean;
  dirtyRows: DirtyRows;
  template: RowsRes;
  version: number;
  _seen: number;
}

interface SBucket { sum: number; count: number; nonBlank: number; text: number; errors: number; firstError?: CellError; vals?: Value[] }

const INVERTIBLE = new Set(['SUM', 'COUNT', 'COUNTA', 'COUNTBLANK', 'AVG', 'AVERAGE']);
let GEN = 1;

/** Dirty-row set as a growable bitmap. */
class DirtyRows {
  bits = new Uint8Array(0);
  count = 0;
  all = false;
  add(r: number) {
    if (this.all) return;
    if (r >= this.bits.length) { const nb = new Uint8Array(Math.max(r + 1, this.bits.length * 2, 1024)); nb.set(this.bits); this.bits = nb; }
    if (!this.bits[r]) { this.bits[r] = 1; this.count++; }
  }
  addAll(rows: Iterable<number>) { for (const r of rows) this.add(r); }
  markAll() { this.all = true; }
  clear() { if (this.count) this.bits.fill(0); this.count = 0; this.all = false; }
  *rows(): IterableIterator<number> { const b = this.bits; for (let i = 0; i < b.length; i++) if (b[i]) yield i; }
}

export class IncrementalEngine extends EvalCore {
  private cols = new Map<string, ColState>();
  private aggs = new Map<string, AggState>();
  private byTable = new Map<number, Set<ColState | AggState>>();
  private stack: Tracker[] = [];
  /** per-engine property tag so several engines can share one schema (differential tests) */
  private tag = Symbol('finidb.colstate');
  stats = { fullRecomputes: 0, partialRecomputes: 0, aggRescans: 0, aggDeltas: 0, cellsComputed: 0 };

  constructor(db: Database) { super(db); }

  // ---------- write notifications ----------

  /** Column versions as of the last noted row write: a base-column change is row-tracked only if nothing wrote to it un-noted since. */
  private notedVersions = new Map<Field, number>();
  /** A base cell of `table` at `row` changed: dirty the states on that table and, through ref columns, dependent rows of other tables. */
  noteRowWrite(table: Table, row: number, field?: Field) {
    if (field) this.notedVersions.set(field, field.column.version);
    this.propagateRows(table, new Set([row]), new Set(), 0);
  }

  private propagateRows(table: Table, rows: Set<number>, visited: Set<number>, depth: number) {
    const set = this.byTable.get(table.iid);
    if (set) for (const s of set) s.dirtyRows.addAll(rows);
    if (depth >= 3 || visited.has(table.iid)) return;
    visited.add(table.iid);
    for (const m of this.db.models.values()) for (const t of m.tables.values()) {
      if (t.kind !== 'tabular') continue;
      for (const f of t.fields) {
        if (f.type !== 'ref' || f.refTable !== table || f.computed) continue;
        const data = (f.column as any).data as Int32Array;
        const hit: number[] = [];
        const n = t.rowCount;
        if (rows.size === 1) { const [only] = rows; for (let i = 0; i < n; i++) if (data[i] === only) hit.push(i); }
        else for (let i = 0; i < n; i++) if (rows.has(data[i])) hit.push(i);
        if (hit.length) this.propagateRows(t, new Set(hit), visited, depth + 1);
      }
    }
  }
  protected noteRowShift(_t: Table) {
    const top = this.stack[this.stack.length - 1] as ColState | undefined;
    if (top && (top as any).kind !== 'agg') top.noPartial = true;
  }
  private noteRowsChanged(table: Table, rows: Set<number> | 'all', except?: ColState) {
    const set = this.byTable.get(table.iid);
    if (!set) return;
    for (const s of set) {
      if (s === except) continue;
      if (rows === 'all') s.dirtyRows.markAll(); else s.dirtyRows.addAll(rows);
    }
  }

  // ---------- dependency recording ----------

  private recordObj(o: Field | ColState | AggState, ver: Ver) {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    const seen = (o as any)._seen;
    if (seen === top.gen) return;
    (o as any)._seen = top.gen;
    top.deps.set(o, ver);
  }
  private recordKey(key: string, ver: Ver) {
    const top = this.stack[this.stack.length - 1];
    if (top) top.deps.set(key, ver);
  }
  private shapeSig(p: Pivot) { return `${p.version}|${p.dims.map(d => d.table.version).join(',')}`; }

  /** Current version of a dependency, making computed sources fresh first. */
  private currentVersion(dep: DepKey): Ver {
    if (typeof dep !== 'string') {
      if (dep instanceof Field) {
        if (!dep.computed) return dep.column.version;
        const cs = this.colForField(this.tableOf(dep), dep);
        this.ensureFresh(cs);
        return cs.version;
      }
      if ((dep as AggState).kind === 'agg') { this.ensureAggFresh(dep as AggState); return (dep as AggState).version; }
      this.ensureFresh(dep as ColState);
      return (dep as ColState).version;
    }
    const [kind, a] = dep.split(':');
    switch (kind) {
      case 'pin': { const p = this.pivotByIid(Number(a)); return p ? p.inputVersion : -1; }
      case 'rules': { const t = this.anyByIid(Number(a)); return t ? t.rulesVersion : -1; }
      case 'rows': { const t = this.tableByIid(Number(a)); return t ? t.version : -1; }
      case 'shape': { const p = this.pivotByIid(Number(a)); return p ? this.shapeSig(p) : ''; }
      default: return -1;
    }
  }
  private fieldTables = new Map<Field, Table>();
  private tableOf(f: Field): Table {
    const t = this.fieldTables.get(f);
    if (t) return t;
    for (const m of this.db.models.values()) for (const tb of m.tables.values()) if (tb.kind === 'tabular' && tb.fields.includes(f)) { this.fieldTables.set(f, tb); return tb; }
    throw new Error('orphan field');
  }
  private pivotByIid(iid: number): Pivot | undefined { for (const m of this.db.models.values()) for (const t of m.tables.values()) if (t.kind === 'pivot' && t.iid === iid) return t; return undefined; }
  private tableByIid(iid: number): Table | undefined { for (const m of this.db.models.values()) for (const t of m.tables.values()) if (t.kind === 'tabular' && t.iid === iid) return t; return undefined; }
  private anyByIid(iid: number) { for (const m of this.db.models.values()) for (const t of m.tables.values()) if (t.iid === iid) return t; return undefined; }

  // ---------- column states ----------

  private colForMeasure(p: Pivot, m: Measure): ColState {
    let cs = (m as any)[this.tag] as ColState | undefined;
    if (!cs) { cs = this.newCol('measure', 0); cs.pivot = p; cs.measure = m; (m as any)[this.tag] = cs; this.cols.set(`m:${p.iid}:${m.iid}`, cs); }
    return cs;
  }
  private colForField(t: Table, f: Field): ColState {
    let cs = (f as any)[this.tag] as ColState | undefined;
    if (!cs) {
      cs = this.newCol('field', t.rowCount); cs.table = t; cs.field = f;
      (f as any)[this.tag] = cs;
      this.cols.set(`f:${f.iid}`, cs);
      this.fieldTables.set(f, t);
      let set = this.byTable.get(t.iid); if (!set) { set = new Set(); this.byTable.set(t.iid, set); }
      set.add(cs);
    }
    return cs;
  }
  private newCol(kind: 'measure' | 'field', size: number): ColState {
    return { kind, gen: 0, deps: new Map(), values: new Float64Array(size), other: new Map(), state: new Uint8Array(size), size, version: 0, computedOnce: false, checkedAt: -1, computing: false, checking: false, noPartial: false, dirtyRows: new DirtyRows(), _seen: 0 };
  }
  private read(cs: ColState, i: number): Value {
    const st = cs.state[i];
    if (st === 1) return cs.values[i];
    if (st === 2) return cs.other.get(i) ?? null;
    return null;
  }
  private write(cs: ColState, i: number, v: Value) {
    if (v === null || v === undefined || v === '') { if (cs.state[i] === 2) cs.other.delete(i); cs.state[i] = 3; return; }
    if (typeof v === 'number') { if (cs.state[i] === 2) cs.other.delete(i); cs.state[i] = 1; cs.values[i] = v; return; }
    cs.state[i] = 2; cs.other.set(i, v);
  }
  private sameValue(aSt: number, aVal: number, aOther: Value | undefined, bSt: number, bVal: number, bOther: Value | undefined): boolean {
    if (aSt !== bSt) return false;
    if (aSt === 1) return aVal === bVal;
    if (aSt === 2) { if (isError(aOther) || isError(bOther)) return isError(aOther) && isError(bOther) && aOther.error === bOther.error; return aOther === bOther; }
    return true;
  }

  // ---------- freshness ----------

  /** Columns whose full recompute was started lazily while another column was computing (doc 05 §8). */
  private pending = new Map<ColState, Snapshot>();
  /** Number of ensureFresh checks in progress; pending columns are only finished when this is zero. */
  private checkingDepth = 0;

  private ensureFresh(cs: ColState) {
    if (cs.computing) return;
    if (cs.checking) {
      // read (or version-checked) while we are still deciding whether we are fresh: a cycle in the column graph
      // (statements referencing each other across periods). Assume stale and start computing now, cell by cell on
      // demand, so every reader in the cycle sees values derived from the current inputs.
      this.pending.set(cs, this.startFull(cs));
      return;
    }
    if (cs.checkedAt === this.db.version && cs.computedOnce) return;
    cs.checking = true; this.checkingDepth++;
    const gen0 = cs.gen;
    try {
      let stale = !cs.computedOnce;
      let allBase = true;
      if (!stale) {
        for (const [k, v] of cs.deps) {
          if (k === cs) continue;   // a self-reference (PREV on the same line) records our own provisional version
          if (this.currentVersion(k) !== v) { stale = true; if (!this.rowTracked(k, cs.table)) allBase = false; }
          if (cs.gen !== gen0) break;   // a dependency's recompute forced ours (cycle) — possibly finished already
        }
      }
      if (cs.gen !== gen0) {
        // forced into a full recompute during our own check (a column cycle): it is pending and finishes in
        // drainPending once no column is computing or checking, so nothing can force it a second time
      } else if (stale) {
        const partial = cs.computedOnce && cs.kind === 'field' && !cs.noPartial && !cs.dirtyRows.all && allBase && cs.table!.rowCount === cs.size;
        if (partial) { this.recomputeRows(cs, cs.dirtyRows.rows()); cs.dirtyRows.clear(); cs.checkedAt = this.db.version; }
        else if (this.stack.length > 0) {
          // nested under another column's computation: compute this column's cells on demand and finish it later,
          // so mutually dependent columns (statements referencing each other across periods) resolve cell by cell
          this.pending.set(cs, this.startFull(cs));
          return;
        } else {
          const snap = this.startFull(cs);
          for (let i = 0; i < cs.size; i++) if (cs.state[i] === 0) this.computeOne(cs, i);
          this.finishFull(cs, snap);
        }
      } else { cs.dirtyRows.clear(); cs.checkedAt = this.db.version; }
    } finally { cs.checking = false; this.checkingDepth--; }
    if (this.stack.length === 0 && this.checkingDepth === 0) this.drainPending();
  }
  /** Finish every lazily started column: compute the cells nobody asked for yet, then diff and bump versions. */
  private drainPending() {
    while (this.pending.size) {
      const [cs, snap] = this.pending.entries().next().value as [ColState, Snapshot];
      for (let i = 0; i < cs.size; i++) if (cs.state[i] === 0) this.computeOne(cs, i);
      this.pending.delete(cs);
      this.finishFull(cs, snap);
    }
  }

  /** A changed dependency whose affected rows are known to be in our dirty set: any base column (propagated through refs), or a computed column of the same table (noteRowsChanged). */
  private rowTracked(dep: DepKey, table: Table | undefined): boolean {
    if (dep instanceof Field) return dep.computed ? this.fieldTables.get(dep) === table : this.notedVersions.get(dep) === dep.column.version;
    if (typeof dep === 'string') return false;
    if ((dep as AggState).kind === 'agg') return false;
    return (dep as ColState).kind === 'field' && (dep as ColState).table === table;
  }
  /** Mark a column as computing and record its structural dependencies. Cells are computed by computeOne, which pushes the column while it runs. */
  private beginCompute(cs: ColState, keepDeps: boolean) {
    cs.computing = true;
    cs.gen = GEN++;
    if (!keepDeps) cs.deps = new Map();
    this.stack.push(cs);
    try {
      if (cs.kind === 'measure') {
        const p = cs.pivot!;
        this.recordKey(`rules:${p.iid}`, p.rulesVersion);
        this.recordKey(`pin:${p.iid}`, p.inputVersion);
        this.recordKey(`shape:${p.iid}`, this.shapeSig(p));
        for (const d of p.dims) this.recordKey(`rows:${d.table.iid}`, d.table.version);
      } else {
        const t = cs.table!;
        this.recordKey(`rules:${t.iid}`, t.rulesVersion);
        this.recordKey(`rows:${t.iid}`, t.version);
      }
    } finally { this.stack.pop(); }
  }
  private endCompute(cs: ColState) {
    cs.computing = false;
    cs.computedOnce = true;
    if (cs.deps.has(cs)) cs.noPartial = true;
  }

  /** Allocate fresh result arrays (keeping the old ones for the diff) and begin a full recompute. */
  private startFull(cs: ColState): Snapshot {
    this.stats.fullRecomputes++;
    const size = cs.kind === 'measure' ? cs.pivot!.totalCells() : cs.table!.rowCount;
    const snap: Snapshot = { values: cs.values, state: cs.state, other: cs.other, size: cs.size, computedOnce: cs.computedOnce, version: cs.version };
    cs.values = new Float64Array(size); cs.state = new Uint8Array(size); cs.other = new Map(); cs.size = size;
    cs.noPartial = false;
    // provisional version: anything that reads our cells while this pass runs (nested columns, aggregates) sees final
    // values for this pass and must record a version that survives finishFull; restored below if nothing changed
    cs.version++;
    this.beginCompute(cs, false);
    return snap;
  }
  /** Diff against the previous contents, bump the version when anything changed, propagate changed rows. */
  private finishFull(cs: ColState, snap: Snapshot) {
    this.endCompute(cs);
    const size = cs.size;
    let changed: Set<number> | 'all' = new Set();
    if (snap.size !== size || !snap.computedOnce) changed = 'all';
    else for (let i = 0; i < size; i++) if (!this.sameValue(snap.state[i], snap.values[i], snap.state[i] === 2 ? snap.other.get(i) : undefined, cs.state[i], cs.values[i], cs.state[i] === 2 ? cs.other.get(i) : undefined)) changed.add(i);
    if (changed === 'all' || changed.size) {
      if (cs.kind === 'field') this.noteRowsChanged(cs.table!, changed, cs);
    } else cs.version = snap.version;   // unchanged: dependents that read the old values stay fresh
    cs.dirtyRows.clear();
    cs.checkedAt = this.db.version;
  }
  private recomputeRows(cs: ColState, rows: Iterable<number>) {
    this.stats.partialRecomputes++;
    this.beginCompute(cs, true);   // keep previously recorded deps: a partial pass may not exercise every branch
    const changed = new Set<number>();
    try {
      for (const r of rows) {
        if (r >= cs.size) continue;
        const oSt = cs.state[r], oVal = cs.values[r], oOther = oSt === 2 ? cs.other.get(r) : undefined;
        cs.state[r] = 0;
        this.computeOne(cs, r);
        if (!this.sameValue(oSt, oVal, oOther, cs.state[r], cs.values[r], cs.state[r] === 2 ? cs.other.get(r) : undefined)) changed.add(r);
      }
    } finally { this.endCompute(cs); }
    // refresh the recorded versions of everything we depend on
    for (const k of cs.deps.keys()) if (k !== cs) cs.deps.set(k, this.currentVersion(k));
    if (changed.size) { cs.version++; this.noteRowsChanged(cs.table!, changed, cs); }
  }
  private computeOne(cs: ColState, i: number) {
    cs.state[i] = 4;
    this.stats.cellsComputed++;
    this.stack.push(cs);
    let v: Value;
    try {
      if (cs.kind === 'measure') v = this.computeCell(cs.pivot!, cs.measure!, this.decode(cs.pivot!, i));
      else v = this.computeField(cs.table!, cs.field!, i);
    } catch (e) {
      if (e instanceof Error && 'code' in e) v = err((e as any).code, (e as any).detail ?? e.message); else throw e;
    } finally { this.stack.pop(); }
    this.write(cs, i, v);
  }
  private decode(p: Pivot, addr: number): Int32Array {
    const dims = p.dims;
    const coord = new Int32Array(dims.length);
    let rem = addr;
    for (let i = dims.length - 1; i >= 0; i--) { const r = dims[i].table.rowCount; coord[i] = rem % r; rem = Math.floor(rem / r); }
    return coord;
  }
  private encode(p: Pivot, coord: Int32Array): number {
    let a = 0;
    const dims = p.dims;
    for (let i = 0; i < dims.length; i++) a = a * dims[i].table.rowCount + coord[i];
    return a;
  }

  // ---------- tier-2: compiled row rules ----------

  recordField(f: Field) { this.recordObj(f, f.column.version); }
  private compiledFor(rule: Rule, table: Table): RowFn | null {
    const c = (rule as any)._compiled as { sv: number; t: Table; fn: RowFn | null } | undefined;
    if (c && c.sv === this.db.schemaVersion && c.t === table) return c.fn;
    const fn = compileRowRule(this, table, rule);
    (rule as any)._compiled = { sv: this.db.schemaVersion, t: table, fn };
    return fn;
  }
  protected computeField(table: Table, field: Field, row: number): Value {
    const ctx: Ctx = { kind: 'row', table, row };
    const rule = this.governingRule(table.rules, field.id, ctx);
    if (!rule) return null;
    const fn = this.compiledFor(rule, table);
    let v: Value;
    if (fn) v = fn(row);
    else { try { v = this.evalNode(rule.ast!, ctx); } catch (e) { if (e instanceof Error && 'code' in e) v = err((e as any).code, (e as any).detail ?? e.message); else throw e; } }
    if (field.type === 'ref' && typeof v === 'string') { const r = field.refTable!.memberIndex(v); v = r < 0 ? err('REF', `no member ${v}`) : r; }
    this.counters.cellsEvaluated++;
    return v;
  }

  // ---------- EvalCore storage hooks ----------

  cell(pivot: Pivot, measure: Measure, coord: Int32Array): Value {
    const cs = this.colForMeasure(pivot, measure);
    const addr = this.encode(pivot, coord);
    if (!cs.computing) this.ensureFresh(cs);   // may leave cs computing (started lazily under another column)
    this.recordObj(cs, cs.version);
    if (addr >= cs.size) return null;
    if (cs.computing) {
      const st = cs.state[addr];
      if (st === 4) return err('CYCLE', `${pivot.id}.${measure.id} depends on itself`);
      if (st === 0) this.computeOne(cs, addr);
    }
    return this.read(cs, addr);
  }

  field(table: Table, field: Field, row: number): Value {
    if (!field.computed) {
      this.recordObj(field, field.column.version);
      return field.column.get(row);
    }
    const cs = this.colForField(table, field);
    if (!cs.computing) this.ensureFresh(cs);   // may leave cs computing (started lazily under another column)
    this.recordObj(cs, cs.version);
    if (row >= cs.size) return null;
    if (cs.computing) {
      const st = cs.state[row];
      if (st === 4) return err('CYCLE', `${table.id}.${field.id} depends on itself`);
      if (st === 0) this.computeOne(cs, row);
    }
    return this.read(cs, row);
  }

  // ---------- correlated aggregates ----------

  protected aggregateRows(fn: string, res: RowsRes, ctx: Ctx): Value {
    const key = `${res.table.iid}:${res.field.iid}:${res.key}:${ctx.kind === 'pivot' ? ctx.pivot.iid : ctx.table.iid}:${fn}`;
    let s = this.aggs.get(key);
    const numeric = !INVERTIBLE.has(fn) ? false : res.corr.every(c => c.rowIdx !== undefined);
    if (!s) {
      s = { kind: 'agg', gen: 0, deps: new Map(), table: res.table, fn, numeric, strides: [], nBuckets: 0, sum: new Float64Array(0), count: new Int32Array(0), nonBlank: new Int32Array(0), errors: new Int32Array(0), text: new Int32Array(0), firstError: new Map(), rowBucket: new Int32Array(0), rowVal: new Float64Array(0), rowOther: new Map(), rowState: new Uint8Array(0), sbuckets: new Map(), srowBucket: [], srowVal: [], keepVals: !INVERTIBLE.has(fn), computedOnce: false, checkedAt: -1, checking: false, dirtyRows: new DirtyRows(), template: res, version: 0, _seen: 0 };
      this.aggs.set(key, s);
      let set = this.byTable.get(res.table.iid); if (!set) { set = new Set(); this.byTable.set(res.table.iid, set); }
      set.add(s);
    }
    s.template = res;
    this.ensureAggFresh(s);
    this.recordObj(s, s.version);
    if (s.numeric) {
      let b = 0;
      for (let i = 0; i < res.corr.length; i++) { const ci = res.corr[i].ctxIdx!; if (ci < 0) return FUNCTIONS[fn]([]); b += ci * s.strides[i]; }
      if (b >= s.nBuckets) return FUNCTIONS[fn]([]);
      if (s.errors[b] > 0) return s.firstError.get(b)!;
      switch (fn) {
        case 'SUM': return s.text[b] > 0 ? err('TYPE', 'SUM over non-numeric values') : s.sum[b];
        case 'COUNT': return s.count[b];
        case 'COUNTA': return s.count[b] + s.text[b];
        case 'COUNTBLANK': return s.nonBlank[b];
        default: return s.text[b] > 0 ? err('TYPE', 'AVG over non-numeric values') : (s.count[b] ? s.sum[b] / s.count[b] : null);
      }
    }
    const b = s.sbuckets.get(this.ctxBucketKey(res));
    if (!b) return FUNCTIONS[fn]([]);
    if (b.errors > 0) return b.firstError!;
    if (b.vals) return FUNCTIONS[fn](b.vals);
    switch (fn) {
      case 'SUM': return b.text > 0 ? err('TYPE', 'SUM over non-numeric values') : b.sum;
      case 'COUNT': return b.count;
      case 'COUNTA': return b.count + b.text;
      case 'COUNTBLANK': return b.nonBlank;
      default: return b.text > 0 ? err('TYPE', 'AVG over non-numeric values') : (b.count ? b.sum / b.count : null);
    }
  }

  private ensureAggFresh(s: AggState) {
    if (s.checking) return;
    if (s.checkedAt === this.db.version && s.computedOnce) return;
    s.checking = true;
    try {
      let stale = !s.computedOnce;
      let allBase = true;
      if (!stale) for (const [k, v] of s.deps) if (this.currentVersion(k) !== v) { stale = true; if (!this.rowTracked(k, s.table)) allBase = false; }
      if (stale) {
        const delta = s.computedOnce && !s.dirtyRows.all && !s.keepVals && allBase && s.table.rowCount === (s.numeric ? s.rowBucket.length : s.srowBucket.length) && this.sameShape(s);
        if (delta) this.aggDelta(s, s.dirtyRows.rows()); else this.aggRescan(s);
      }
      s.dirtyRows.clear();
      s.checkedAt = this.db.version;
    } finally { s.checking = false; }
  }
  private sameShape(s: AggState): boolean {
    if (!s.numeric) return true;
    const res = s.template;
    let n = 1; for (const c of res.corr) n *= c.radix!;
    return n === s.nBuckets;
  }
  private numericBucket(s: AggState, r: number): number {
    const res = s.template;
    if (!res.filters.every(f => f(r))) return -1;
    let b = 0;
    for (let i = 0; i < res.corr.length; i++) { const idx = res.corr[i].rowIdx!(r); if (idx < 0) return -1; b += idx * s.strides[i]; }
    return b;
  }
  private addNum(s: AggState, b: number, v: Value) {
    if (isError(v)) { s.errors[b]++; if (!s.firstError.has(b)) s.firstError.set(b, v); return; }
    if (v === null || v === '') { s.nonBlank[b]++; return; }
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
    if (n === null) { s.text[b]++; return; }
    s.sum[b] += n; s.count[b]++;
  }
  private removeNum(s: AggState, b: number, st: number, val: number, other: Value | undefined) {
    if (st === 1) { s.sum[b] -= val; s.count[b]--; return; }
    if (st === 3) { s.nonBlank[b]--; return; }
    if (isError(other)) { s.errors[b]--; if (s.errors[b] === 0) s.firstError.delete(b); return; }
    const n = typeof other === 'string' && other.trim() !== '' && !Number.isNaN(Number(other)) ? Number(other) : null;
    if (n === null) { s.text[b]--; return; }
    s.sum[b] -= n; s.count[b]--;
  }
  private storeRow(s: AggState, r: number, b: number, v: Value) {
    s.rowBucket[r] = b;
    if (v === null || v === undefined || v === '') { s.rowState[r] = 3; s.rowOther.delete(r); }
    else if (typeof v === 'number') { s.rowState[r] = 1; s.rowVal[r] = v; s.rowOther.delete(r); }
    else { s.rowState[r] = 2; s.rowOther.set(r, v); }
  }

  private sAdd(b: SBucket, v: Value) {
    if (isError(v)) { b.errors++; b.firstError ??= v; return; }
    if (v === null || v === '') { b.nonBlank++; return; }
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
    if (n === null) { b.text++; return; }
    b.sum += n; b.count++;
  }
  private sRemove(b: SBucket, v: Value) {
    if (isError(v)) { b.errors--; if (!b.errors) b.firstError = undefined; return; }
    if (v === null || v === '') { b.nonBlank--; return; }
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
    if (n === null) { b.text--; return; }
    b.sum -= n; b.count--;
  }
  private aggRescan(s: AggState) {
    this.stats.aggRescans++;
    const res = s.template;
    s.gen = GEN++; s.deps = new Map();
    this.stack.push(s);
    try {
      this.recordKey(`rows:${s.table.iid}`, s.table.version);
      const n = s.table.rowCount;
      if (s.numeric) {
        s.strides = []; let m = 1;
        for (let i = res.corr.length - 1; i >= 0; i--) { s.strides[i] = m; m *= res.corr[i].radix!; }
        s.nBuckets = m;
        s.sum = new Float64Array(m); s.count = new Int32Array(m); s.nonBlank = new Int32Array(m); s.errors = new Int32Array(m); s.text = new Int32Array(m); s.firstError = new Map();
        s.rowBucket = new Int32Array(n); s.rowVal = new Float64Array(n); s.rowState = new Uint8Array(n); s.rowOther = new Map();
        for (let r = 0; r < n; r++) {
          this.counters.rowsScanned++;
          const b = this.numericBucket(s, r);
          if (b < 0) { s.rowBucket[r] = -1; continue; }
          const v = this.rowFieldValue(res, r);
          this.storeRow(s, r, b, v);
          this.addNum(s, b, v);
        }
      } else {
        s.sbuckets = new Map(); s.srowBucket = new Array(n); s.srowVal = new Array(n);
        for (let r = 0; r < n; r++) {
          this.counters.rowsScanned++;
          if (!res.filters.every(f => f(r))) { s.srowBucket[r] = null; continue; }
          let bk = ''; for (const c of res.corr) bk += c.rowKey(r) + '';
          const v = this.rowFieldValue(res, r);
          s.srowBucket[r] = bk; s.srowVal[r] = v;
          let b = s.sbuckets.get(bk);
          if (!b) { b = { sum: 0, count: 0, nonBlank: 0, text: 0, errors: 0, vals: s.keepVals ? [] : undefined }; s.sbuckets.set(bk, b); }
          if (b.vals) b.vals.push(v); else this.sAdd(b, v);
        }
      }
    } finally { this.stack.pop(); }
    s.computedOnce = true;
    s.version++;
  }

  private aggDelta(s: AggState, rows: Iterable<number>) {
    this.stats.aggDeltas++;
    const res = s.template;
    s.gen = GEN++;   // keep deps; a delta pass may not exercise every branch
    this.stack.push(s);
    let changed = false;
    try {
      if (s.numeric) {
        for (const r of rows) {
          if (r >= s.rowBucket.length) continue;
          const ob = s.rowBucket[r];
          const b = this.numericBucket(s, r);
          const v = b < 0 ? null : this.rowFieldValue(res, r);
          // unchanged contribution?
          if (ob === b && b >= 0 && ((typeof v === 'number' && s.rowState[r] === 1 && s.rowVal[r] === v) || (v === null && s.rowState[r] === 3))) continue;
          if (ob === b && b < 0) continue;
          if (ob >= 0) this.removeNum(s, ob, s.rowState[r], s.rowVal[r], s.rowState[r] === 2 ? s.rowOther.get(r) : undefined);
          if (b >= 0) { this.storeRow(s, r, b, v); this.addNum(s, b, v); } else { s.rowBucket[r] = -1; s.rowOther.delete(r); }
          changed = true;
        }
      } else {
        for (const r of rows) {
          if (r >= s.srowBucket.length) continue;
          const obk = s.srowBucket[r];
          if (obk !== null) this.sRemove(s.sbuckets.get(obk)!, s.srowVal[r]);
          if (!res.filters.every(f => f(r))) { s.srowBucket[r] = null; changed = true; continue; }
          let bk = ''; for (const c of res.corr) bk += c.rowKey(r) + '';
          const v = this.rowFieldValue(res, r);
          s.srowBucket[r] = bk; s.srowVal[r] = v;
          let b = s.sbuckets.get(bk);
          if (!b) { b = { sum: 0, count: 0, nonBlank: 0, text: 0, errors: 0 }; s.sbuckets.set(bk, b); }
          this.sAdd(b, v);
          changed = true;
        }
      }
    } finally { this.stack.pop(); }
    for (const k of s.deps.keys()) s.deps.set(k, this.currentVersion(k));
    if (changed) s.version++;
  }
}
