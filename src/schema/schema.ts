/**
 * Schema objects. Every object has a stable internal integer id and a user-visible id (doc 03 §2).
 */
import type { TableSource } from '../source/types.js';
import { Column, TextColumn, RefColumn, makeColumn, FieldType, Scalar } from '../store/column.js';
import type { Rule } from './rules.js';

export class Field {
  computed = false;
  format?: string;
  constructor(
    public readonly iid: number,
    public id: string,
    public name: string,
    public readonly type: FieldType,
    public readonly column: Column,
    public readonly refTable?: Table,
  ) {}
}

export class Table {
  readonly kind = 'tabular' as const;
  fields: Field[] = [];
  fieldById = new Map<string, Field>();
  rules: Rule[] = [];
  /** id -> row index */
  rowById = new Map<string, number>();
  rowCount = 0;
  version = 0;
  rulesVersion = 0;
  /** Derived table: distinct values of source.field */
  distinctOf?: { table: Table; field: Field };
  /** Linked table: rows come from an HTTP source, refreshed on demand (src/source). */
  source?: TableSource;
  /** Tracked table: the engine keeps added_by, added_at, changed_by and changed_at on every row. */
  track = false;
  constructor(public readonly iid: number, public id: string, public name: string, public readonly model: Model) {
    this.addField('id', 'ID', 'text');
  }
  get idField(): Field { return this.fields[0]; }
  addField(id: string, name: string, type: FieldType, refTable?: Table): Field {
    if (this.fieldById.has(id)) throw new Error(`SCHEMA_DUPLICATE_FIELD: ${this.id}.${id}`);
    const col = makeColumn(type, refTable?.iid);
    col.ensure(this.rowCount);
    col.length = this.rowCount;
    for (let i = 0; i < this.rowCount; i++) col.set(i, null);   // a field added to a populated table starts blank, whatever the column's zero value is
    const f = new Field(this.model.db.nextIid(), id, name, type, col, refTable);
    this.fields.push(f);
    this.fieldById.set(id, f);
    this.version++;
    this.model.db.schemaVersion++;
    return f;
  }
  field(id: string): Field {
    const f = this.fieldById.get(id) ?? this.fields.find(x => x.name === id);
    if (!f) throw new Error(`SCHEMA_NO_FIELD: ${this.id}.${id}`);
    return f;
  }
  hasField(id: string): boolean { return this.fieldById.has(id) || this.fields.some(x => x.name === id); }

  /** Insert a row given by an object keyed by field id. Ref fields accept the target row's id string. */
  insertRow(row: Record<string, Scalar>): number {
    const idRaw = row.id;
    const id = idRaw === undefined || idRaw === null ? String(this.rowCount + 1) : String(idRaw);
    if (this.rowById.has(id)) throw new Error(`DATA_DUPLICATE_ID: ${this.id}.${id}`);
    const i = this.rowCount++;
    for (const f of this.fields) {
      f.column.ensure(this.rowCount);
      f.column.length = this.rowCount;
      if (f.id === 'id') { f.column.set(i, id); continue; }
      const v = row[f.id] ?? row[f.name];
      f.column.set(i, this.coerce(f, v === undefined ? null : v));
    }
    this.rowById.set(id, i);
    this.version++;
    return i;
  }
  coerce(f: Field, v: Scalar): Scalar {
    if (f.type === 'ref' && v !== null && typeof v !== 'number') {
      const target = f.refTable!;
      const r = target.rowById.get(String(v));
      if (r === undefined) throw new Error(`DATA_UNKNOWN_REF: ${this.id}.${f.id} = "${v}" not found in ${target.id}`);
      return r;
    }
    return v;
  }
  setCell(rowId: string, fieldId: string, v: Scalar) {
    const r = this.rowById.get(rowId);
    if (r === undefined) throw new Error(`DATA_NO_ROW: ${this.id}.${rowId}`);
    const f = this.field(fieldId);
    f.column.set(r, this.coerce(f, v));
    this.model.db.touch();
  }
  rowId(i: number): string { return (this.idField.column as TextColumn).get(i) as string; }

  /** Delete rows by id: compact every column, rebuild rowById, and remap ref columns in other tables (deleted targets become null). */
  deleteRows(ids: string[]): number {
    const drop = new Set<number>();
    for (const id of ids) { const r = this.rowById.get(id); if (r !== undefined) drop.add(r); }
    if (!drop.size) return 0;
    const n = this.rowCount;
    const remap = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) remap[i] = drop.has(i) ? -1 : k++;
    for (const f of this.fields) {
      const col = f.column;
      for (let i = 0; i < n; i++) { const j = remap[i]; if (j >= 0 && j !== i) col.set(j, col.get(i)); }
      col.length = k; col.version++;
    }
    this.rowById.clear();
    for (let i = 0; i < k; i++) this.rowById.set(this.rowId(i), i);
    this.rowCount = k;
    // remap references from every table (including self-references)
    for (const t of this.model.tables.values()) {
      if (t.kind !== 'tabular') continue;
      for (const f of t.fields) {
        if (f.type !== 'ref' || f.refTable !== this) continue;
        const data = (f.column as RefColumn).data;
        for (let i = 0; i < t.rowCount; i++) { const v = data[i]; if (v >= 0) data[i] = remap[v]; }
        f.column.version++;
      }
    }
    this.version++;
    this.model.db.schemaVersion++;   // member indexes shifted: resolution caches must refresh
    this.model.db.touch();
    return drop.size;
  }
  dropField(id: string) {
    const f = this.field(id);
    if (f.id === 'id') throw new Error('SCHEMA_CANNOT_DROP_ID');
    this.fields = this.fields.filter(x => x !== f);
    this.fieldById.delete(f.id);
    this.rules = this.rules.filter(r => r.target !== f.id);
    this.version++; this.rulesVersion++;
    this.model.db.schemaVersion++;
    this.model.db.touch();
  }
  memberIndex(id: string): number {
    const r = this.rowById.get(id);
    if (r === undefined) {
      // allow lookup by display name if a 'name' field exists
      const nf = this.fieldById.get('name');
      if (nf) for (let i = 0; i < this.rowCount; i++) if (nf.column.get(i) === id) return i;
      return -1;
    }
    return r;
  }
}

export class Dim {
  constructor(public readonly iid: number, public id: string, public name: string, public readonly table: Table) {}
}
export class Measure {
  format?: string;
  constructor(public readonly iid: number, public id: string, public name: string, public readonly type: FieldType) {}
}

export class Pivot {
  readonly kind = 'pivot' as const;
  dims: Dim[] = [];
  measures: Measure[] = [];
  lineDim?: Dim;
  timeDim?: Dim;
  rules: Rule[] = [];
  /** inputs: measure iid -> Map<memberTupleKey, value> where key = member ids joined by  */
  inputs = new Map<number, Map<string, Scalar>>();
  version = 0;
  rulesVersion = 0;
  inputVersion = 0;
  constructor(public readonly iid: number, public id: string, public name: string, public readonly model: Model) {}

  addDim(id: string, table: Table, name = id): Dim {
    if (this.dims.some(d => d.id === id)) throw new Error(`SCHEMA_DUPLICATE_DIM: ${this.id}.${id}`);
    const d = new Dim(this.model.db.nextIid(), id, name, table);
    this.dims.push(d);
    this.version++;
    this.model.db.schemaVersion++;
    return d;
  }
  addMeasure(id: string, type: FieldType = 'number', name = id): Measure {
    if (this.measures.some(m => m.id === id)) throw new Error(`SCHEMA_DUPLICATE_MEASURE: ${this.id}.${id}`);
    const m = new Measure(this.model.db.nextIid(), id, name, type);
    this.measures.push(m);
    this.version++;
    this.model.db.schemaVersion++;
    return m;
  }
  dim(id: string): Dim | undefined { return this.dims.find(d => d.id === id || d.name === id); }
  measure(id: string): Measure | undefined { return this.measures.find(m => m.id === id || m.name === id); }
  get defaultMeasure(): Measure {
    if (this.measures.length === 0) throw new Error(`SCHEMA_NO_MEASURE: ${this.id}`);
    return this.measures[0];
  }
  dimIndex(d: Dim): number { return this.dims.indexOf(d); }
  /** Radices in dim order. */
  radices(): number[] { return this.dims.map(d => d.table.rowCount); }
  totalCells(): number { return this.radices().reduce((a, b) => a * b, 1); }
  tupleKey(coord: ArrayLike<number>): string {
    let s = '';
    for (let i = 0; i < this.dims.length; i++) s += (i ? '' : '') + this.dims[i].table.rowId(coord[i]);
    return s;
  }
  setInput(measure: Measure, coord: ArrayLike<number>, v: Scalar | undefined) {
    let m = this.inputs.get(measure.iid);
    if (!m) { m = new Map(); this.inputs.set(measure.iid, m); }
    const k = this.tupleKey(coord);
    if (v === undefined || v === null) m.delete(k); else m.set(k, v);
    this.inputVersion++;
    this.model.db.touch();
  }
  getInput(measure: Measure, coord: ArrayLike<number>): Scalar | undefined {
    const m = this.inputs.get(measure.iid);
    if (!m) return undefined;
    return m.get(this.tupleKey(coord));
  }
  /** Resolve a coordinate object {dimId: memberId} to member indexes. */
  coordOf(at: Record<string, string>): Int32Array {
    const c = new Int32Array(this.dims.length);
    for (let i = 0; i < this.dims.length; i++) {
      const d = this.dims[i];
      const m = at[d.id] ?? at[d.name];
      if (m === undefined) throw new Error(`COORD_MISSING_DIM: ${this.id}.${d.id}`);
      const idx = d.table.memberIndex(String(m));
      if (idx < 0) throw new Error(`COORD_NO_MEMBER: ${d.id}=${m}`);
      c[i] = idx;
    }
    return c;
  }
}

export type AnyTable = Table | Pivot;

/** Iterative calculation for same-period circularities (interest on average debt, a minimum-cash revolver): Excel's model. */
export interface IterateSettings { maxIterations: number; tolerance: number }
export const ITERATE_DEFAULTS: IterateSettings = { maxIterations: 100, tolerance: 0.001 };
export function normalizeIterate(v: boolean | Partial<IterateSettings> | null | undefined): IterateSettings | undefined {
  if (!v) return undefined;
  const o = v === true ? {} : v;
  const max = Math.max(1, Math.min(10_000, Math.floor(Number(o.maxIterations ?? ITERATE_DEFAULTS.maxIterations))));
  const tol = Number(o.tolerance ?? ITERATE_DEFAULTS.tolerance);
  return { maxIterations: Number.isFinite(max) ? max : ITERATE_DEFAULTS.maxIterations, tolerance: Number.isFinite(tol) && tol >= 0 ? tol : ITERATE_DEFAULTS.tolerance };
}

export class Model {
  tables = new Map<string, AnyTable>();
  /** When set, cells that depend on themselves within a period are iterated to a fixed point instead of erroring. */
  iterate?: IterateSettings;
  constructor(public readonly iid: number, public id: string, public name: string, public readonly db: Database) {}
  setIterate(v: boolean | Partial<IterateSettings> | null | undefined) { this.iterate = normalizeIterate(v); this.db.touch(); }
  table(id: string): AnyTable {
    const t = this.tables.get(id) ?? [...this.tables.values()].find(t => t.name === id);
    if (!t) throw new Error(`SCHEMA_NO_TABLE: ${this.id}.${id}`);
    return t;
  }
  hasTable(id: string) { return this.tables.has(id) || [...this.tables.values()].some(t => t.name === id); }
  createTable(id: string, name = id): Table {
    if (this.tables.has(id)) throw new Error(`SCHEMA_DUPLICATE_TABLE: ${id}`);
    const t = new Table(this.db.nextIid(), id, name, this);
    this.tables.set(id, t);
    this.db.schemaVersion++;
    this.db.touch();
    return t;
  }
  createPivot(id: string, name = id): Pivot {
    if (this.tables.has(id)) throw new Error(`SCHEMA_DUPLICATE_TABLE: ${id}`);
    const p = new Pivot(this.db.nextIid(), id, name, this);
    this.tables.set(id, p);
    this.db.schemaVersion++;
    this.db.touch();
    return p;
  }
}

export class Database {
  models = new Map<string, Model>();
  private iidCounter = 0;
  /** Bumped on every write. The reference evaluator drops its memo when it changes. */
  version = 0;
  /** Bumped on schema changes only (tables, fields, dims, measures). Name resolution caches key on it. */
  schemaVersion = 0;
  nextIid(): number { return ++this.iidCounter; }
  touch() { this.version++; }
  createModel(id: string, name = id): Model {
    if (this.models.has(id)) throw new Error(`SCHEMA_DUPLICATE_MODEL: ${id}`);
    const m = new Model(this.nextIid(), id, name, this);
    this.models.set(id, m);
    return m;
  }
  model(id: string): Model {
    const m = this.models.get(id);
    if (!m) throw new Error(`SCHEMA_NO_MODEL: ${id}`);
    return m;
  }
}

export function refTargetOf(f: Field): Table | undefined {
  return f.type === 'ref' ? f.refTable : undefined;
}
export function isRefColumn(c: Column): c is RefColumn { return c.type === 'ref'; }
