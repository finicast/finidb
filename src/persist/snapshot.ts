/**
 * Binary snapshots (doc 07 §4.2): a dump of INPUTS ONLY — schema, column store, dictionaries,
 * pivot input maps and rules. Nothing the engines maintain (aggregates, dependencies) is
 * stored; it is rebuilt on load.
 *
 * Container layout (`snapshot-<seq>.fdb`):
 *
 *   bytes 0..3   magic "FDB1"
 *   bytes 4..7   uint32 LE  header byte length
 *   header       UTF-8 JSON (see `SnapshotHeader`)
 *   payload      raw sections, each 8-byte aligned, located by header `sections[i].{offset,length}`
 *                (offsets are relative to the start of the payload)
 *
 * Column payloads are the typed arrays as-is (Float64Array/Int32Array/Uint8Array, little-endian);
 * text dictionaries are UTF-8 JSON string arrays. Readable by a 50-line script.
 */
import * as fs from 'node:fs';
import { FiniDB, ReferenceEvaluator } from '../index.js';
import { Database, Model, Table, Pivot, Field } from '../schema/schema.js';
import type { Rule, Clause } from '../schema/rules.js';
import { NumberColumn, DateColumn, BoolColumn, TextColumn, RefColumn } from '../store/column.js';
import type { FieldType, Scalar } from '../store/column.js';

export const MAGIC = 'FDB1';
export const FORMAT_VERSION = 1;

export interface SectionRef { offset: number; length: number; kind: 'f64' | 'i32' | 'u8' | 'json' }
export interface FieldHeader {
  id: string; name: string; type: FieldType; ref?: string; computed: boolean; format?: string;
  /** section indexes: data (f64/i32/u8), nulls (u8), codes (i32), dict (json string[]) */
  data?: number; nulls?: number; codes?: number; dict?: number;
}
export interface RuleHeader { target: string; when: Clause[]; formula: string; name?: string; status: 'ok' | 'invalid'; error?: string }
export interface TableHeader {
  id: string; name: string; rowCount: number;
  fields: FieldHeader[]; rules: RuleHeader[];
  distinctOf?: { table: string; field: string };
}
export interface PivotHeader {
  id: string; name: string;
  dims: { id: string; name: string; table: string }[];
  measures: { id: string; name: string; type: FieldType; format?: string }[];
  lineDim?: string; timeDim?: string;
  rules: RuleHeader[];
  /** measure id -> [tupleKey, value][] (the pivot's input map, doc 03) */
  inputs: [string, [string, Scalar][]][];
}
export interface ModelHeader { id: string; name: string; tables: TableHeader[]; pivots: PivotHeader[] }
export interface SnapshotHeader {
  format: typeof MAGIC; version: number; endian: 'LE';
  /** oplog seq this snapshot covers (0 if unknown) */
  seq: number;
  createdAt: string;
  engine: 'incremental' | 'reference';
  models: ModelHeader[];
  sections: SectionRef[];
}

// ---------- save ----------

class Payload {
  readonly sections: SectionRef[] = [];
  readonly chunks: Buffer[] = [];
  private size = 0;
  add(kind: SectionRef['kind'], bytes: ArrayBufferView): number {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.sections.push({ offset: this.size, length: buf.length, kind });
    this.chunks.push(buf);
    this.size += buf.length;
    const pad = (8 - (this.size % 8)) % 8;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.size += pad; }
    return this.sections.length - 1;
  }
  json(v: unknown): number { return this.add('json', Buffer.from(JSON.stringify(v), 'utf8')); }
}

function ruleHeader(r: Rule): RuleHeader {
  return { target: r.target, when: r.when, formula: r.formula, name: r.name, status: r.status, error: r.error };
}

function fieldHeader(f: Field, n: number, p: Payload): FieldHeader {
  const h: FieldHeader = { id: f.id, name: f.name, type: f.type, ref: f.refTable?.id, computed: f.computed, format: f.format };
  const c = f.column;
  if (c instanceof NumberColumn) { h.data = p.add('f64', c.data.subarray(0, n)); h.nulls = p.add('u8', c.nulls.subarray(0, n)); }
  else if (c instanceof DateColumn) { h.data = p.add('i32', c.data.subarray(0, n)); h.nulls = p.add('u8', c.nulls.subarray(0, n)); }
  else if (c instanceof BoolColumn) h.data = p.add('u8', c.data.subarray(0, n));
  else if (c instanceof TextColumn) { h.codes = p.add('i32', c.codes.subarray(0, n)); h.dict = p.json(c.dict); }
  else if (c instanceof RefColumn) h.data = p.add('i32', c.data.subarray(0, n));
  else throw new Error(`SNAPSHOT_UNKNOWN_COLUMN: ${f.id}`);
  return h;
}

/** Tables ordered so that every ref target (other than the table itself) comes first. */
export function topoSortTables(tables: Table[]): Table[] {
  const out: Table[] = [];
  const state = new Map<Table, 'visiting' | 'done'>();
  const visit = (t: Table) => {
    const s = state.get(t);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`SNAPSHOT_REF_CYCLE: ${t.id}`);
    state.set(t, 'visiting');
    for (const f of t.fields) if (f.refTable && f.refTable !== t) visit(f.refTable);
    if (t.distinctOf) visit(t.distinctOf.table);
    state.set(t, 'done');
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

/** Serialize `f` (inputs only) to `path`. Written atomically via a temp file. */
export function saveSnapshot(f: FiniDB, path: string, opts: { seq?: number } = {}): void {
  const payload = new Payload();
  const models: ModelHeader[] = [];
  for (const m of f.db.models.values()) {
    const all = [...m.tables.values()];
    const tables = topoSortTables(all.filter((t): t is Table => t.kind === 'tabular')).map(t => {
      const th: TableHeader = { id: t.id, name: t.name, rowCount: t.rowCount, fields: t.fields.map(fl => fieldHeader(fl, t.rowCount, payload)), rules: t.rules.map(ruleHeader) };
      if (t.distinctOf) th.distinctOf = { table: t.distinctOf.table.id, field: t.distinctOf.field.id };
      return th;
    });
    const pivots = all.filter((t): t is Pivot => t.kind === 'pivot').map(p => ({
      id: p.id, name: p.name,
      dims: p.dims.map(d => ({ id: d.id, name: d.name, table: d.table.id })),
      measures: p.measures.map(ms => ({ id: ms.id, name: ms.name, type: ms.type, format: ms.format })),
      lineDim: p.lineDim?.id, timeDim: p.timeDim?.id,
      rules: p.rules.map(ruleHeader),
      inputs: p.measures.filter(ms => p.inputs.has(ms.iid)).map(ms => [ms.id, [...p.inputs.get(ms.iid)!.entries()]] as [string, [string, Scalar][]]),
    }));
    models.push({ id: m.id, name: m.name, tables, pivots });
  }
  const header: SnapshotHeader = {
    format: MAGIC, version: FORMAT_VERSION, endian: 'LE', seq: opts.seq ?? 0, createdAt: new Date().toISOString(),
    engine: f.evaluator instanceof ReferenceEvaluator ? 'reference' : 'incremental',
    models, sections: payload.sections,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(headerBuf.length, 0);
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(MAGIC, 'latin1'), len, headerBuf, ...payload.chunks]));
  const fd = fs.openSync(tmp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
}

// ---------- load ----------

/** Parse the container: header plus a payload view. */
export function readSnapshotHeader(path: string): { header: SnapshotHeader; payload: Buffer } {
  const buf = fs.readFileSync(path);
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== MAGIC) throw new Error(`SNAPSHOT_BAD_MAGIC: ${path}`);
  const hlen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + hlen)) as SnapshotHeader;
  if (header.version !== FORMAT_VERSION) throw new Error(`SNAPSHOT_BAD_VERSION: ${header.version}`);
  return { header, payload: buf.subarray(8 + hlen) };
}

/** Copy a section into a fresh typed array (works whatever the buffer alignment). */
function section<T extends Float64Array | Int32Array | Uint8Array>(payload: Buffer, s: SectionRef, ctor: new (n: number) => T, bytesPer: number): T {
  const out = new ctor(s.length / bytesPer);
  new Uint8Array(out.buffer).set(payload.subarray(s.offset, s.offset + s.length));
  return out;
}
function sectionJson<T>(payload: Buffer, s: SectionRef): T { return JSON.parse(payload.toString('utf8', s.offset, s.offset + s.length)) as T; }

function fillColumn(f: Field, h: FieldHeader, n: number, secs: SectionRef[], payload: Buffer) {
  const c = f.column;
  c.ensure(n); c.length = n;
  if (c instanceof NumberColumn) { c.data.set(section(payload, secs[h.data!], Float64Array, 8)); c.nulls.set(section(payload, secs[h.nulls!], Uint8Array, 1)); }
  else if (c instanceof DateColumn) { c.data.set(section(payload, secs[h.data!], Int32Array, 4)); c.nulls.set(section(payload, secs[h.nulls!], Uint8Array, 1)); }
  else if (c instanceof BoolColumn) c.data.set(section(payload, secs[h.data!], Uint8Array, 1));
  else if (c instanceof TextColumn) {
    c.codes.set(section(payload, secs[h.codes!], Int32Array, 4));
    c.dict = sectionJson<string[]>(payload, secs[h.dict!]);
    c.index = new Map(c.dict.map((s, i) => [s, i]));
  }
  else if (c instanceof RefColumn) c.data.set(section(payload, secs[h.data!], Int32Array, 4));
  c.version++;
}

function restoreRules(f: FiniDB, m: Model, t: Table | Pivot, rules: RuleHeader[]) {
  if (rules.length === 0) return;
  // Non-strict so that a rule recorded as invalid does not abort the load; status is then restored verbatim.
  f.setRules(m.id, t.id, rules.map(r => ({ target: r.target, when: r.when, formula: r.formula, name: r.name })), { strict: false, replace: true });
  t.rules.forEach((r, i) => { r.status = rules[i].status; r.error = rules[i].error; });
}

/** Rebuild a working FiniDB from a snapshot file. */
export function loadSnapshot(path: string, opts: { engine?: 'incremental' | 'reference' } = {}): FiniDB {
  const { header, payload } = readSnapshotHeader(path);
  const f = new FiniDB({ engine: opts.engine ?? header.engine });
  const db: Database = f.db;
  for (const mh of header.models) {
    const m = db.createModel(mh.id, mh.name);
    // Pass 1: every Table object exists before any ref field is added, so self- and mutual references resolve.
    const tables = new Map<string, Table>();
    for (const th of mh.tables) tables.set(th.id, m.createTable(th.id, th.name));
    // Pass 2: fields (in dependency order, as saved) with column payloads written directly.
    for (const th of mh.tables) {
      const t = tables.get(th.id)!;
      for (const fh of th.fields) {
        const field = fh.id === 'id' ? t.idField : t.addField(fh.id, fh.name, fh.type, fh.ref !== undefined ? tables.get(fh.ref) : undefined);
        field.computed = fh.computed; field.format = fh.format;
        fillColumn(field, fh, th.rowCount, header.sections, payload);
      }
      t.rowCount = th.rowCount;
      t.rowById = new Map();
      for (let i = 0; i < th.rowCount; i++) t.rowById.set(t.rowId(i), i);
      t.version++;
    }
    for (const th of mh.tables) if (th.distinctOf) { const t = tables.get(th.id)!; t.distinctOf = { table: tables.get(th.distinctOf.table)!, field: tables.get(th.distinctOf.table)!.field(th.distinctOf.field) }; }
    // Pivots: dims, measures, inputs.
    for (const ph of mh.pivots) {
      const p = m.createPivot(ph.id, ph.name);
      for (const d of ph.dims) p.addDim(d.id, tables.get(d.table)!, d.name);
      for (const ms of ph.measures) { const mm = p.addMeasure(ms.id, ms.type, ms.name); mm.format = ms.format; }
      if (ph.lineDim) p.lineDim = p.dim(ph.lineDim);
      if (ph.timeDim) p.timeDim = p.dim(ph.timeDim);
      for (const [measureId, entries] of ph.inputs) p.inputs.set(p.measure(measureId)!.iid, new Map(entries));
      p.inputVersion++;
    }
    // Rules last: every name they refer to now exists. Restore computed flags after, since setRules marks targets.
    for (const th of mh.tables) {
      const t = tables.get(th.id)!;
      restoreRules(f, m, t, th.rules);
      for (const fh of th.fields) t.field(fh.id).computed = fh.computed;
    }
    for (const ph of mh.pivots) restoreRules(f, m, m.table(ph.id) as Pivot, ph.rules);
  }
  db.schemaVersion++;
  db.touch();
  return f;
}
