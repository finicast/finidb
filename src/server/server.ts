/**
 * `finidb serve` — the HTTP server (doc 07 §1–§3, §6). node:http only, no framework.
 *
 * One process hosts many databases, each a `FiniDB` facade held in memory and keyed by name.
 * Every mutation is expressed as a facade-level op `{ method, args }` and goes through `applyOp`,
 * so REST routes, `POST /db/:db/batch` (§3.3), the `/changes` log (§3.2) and the persistence
 * hook (§4, written separately) all see the same stream.
 */
import { exportWorkbook as _exportWorkbook } from '../export/workbook.js';
function require_export() { return { exportWorkbook: _exportWorkbook }; }
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FiniDB, CompileError, ParseError, isError, TRACK_FIELDS } from '../index.js';
import type { QueryOptions, FieldSpec, PeriodsSpec, Scalar, Value, Grid, Clause } from '../index.js';
import type { AnyTable, Table, Pivot, Dim, Measure, Model } from '../schema/schema.js';
import { readOplog, type OpRecord } from '../persist/oplog.js';
import { runJob } from './jobs.js';
import { parseCsv, planLoad, slug, coerce, type ParsedCsv } from '../store/csv.js';
import { fetchSource, envSecrets, secretNamesOf } from '../source/fetch.js';
import { requestsOf, describePresets } from '../source/presets.js';
import { SourceError, type TableSource, type FetchedRows } from '../source/types.js';
import type { FieldType } from '../store/column.js';
import { AuthStore, AuthError, Principal, Role, ROLES } from './auth.js';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** A facade-level operation: the unit of `/batch`, of the change log and of the oplog (§3.3, §4). */
export interface Op { method: string; args: unknown[] }

/**
 * PERSISTENCE HOOK — plug-in point for src/persist (oplog + snapshot, doc 07 §4).
 * The server never touches disk for database contents itself. When `open` is present it is
 * called to (re)hydrate a database from `<dataDir>/<name>`; `append` receives every mutating op
 * after it succeeded; `list` enumerates databases on disk at startup; `drop` deletes one.
 */
export interface PersistenceHook {
  open?: (name: string, dir: string) => FiniDB | undefined | Promise<FiniDB | undefined>;
  append?: (name: string, op: Op, user: string) => void | Promise<void>;
  list?: (dataDir: string) => string[];
  drop?: (name: string, dir: string) => void | Promise<void>;
  /** Copy a database's contents into a new one and open it. */
  copy?: (from: string, fromDir: string, to: string, toDir: string) => FiniDB | undefined | Promise<FiniDB | undefined>;
}

export interface ServerOptions {
  port?: number;                 // default 5488; 0 = ephemeral
  host?: string;                 // default 'localhost'
  dataDir?: string;              // default ~/.finidb; holds auth.json (and, later, databases)
  requireAuth?: boolean;         // default: host is not loopback (§2); forced on for non-loopback hosts
  persistence?: PersistenceHook;
  log?: (line: string) => void;  // request log; silent by default
  bodyLimit?: number;            // bytes; default 64 MiB (§6 "upload size caps")
  /** Linked tables: secrets for {{secret:name}} (default: from the environment, FMP_API_KEY -> fmp), the fetch to use, and whether private hosts may be fetched (default: only when the host is loopback). */
  secrets?: Record<string, string>;
  fetch?: typeof fetch;
  allowPrivateSources?: boolean;
  /** Compile workbooks on a worker thread, so a long one does not block every other request (default: on). */
  workers?: boolean;
}

export interface ServerHandle {
  close(): Promise<void>;
  port: number;
  host: string;
  url: string;
  auth: AuthStore;
  databases: Map<string, DbEntry>;
}

export interface DbEntry {
  name: string;
  f: FiniDB;
  created: string;
  /** Recent mutations, for `/changes` (§3.2): db version after the op and the tables it touched. */
  changes: { version: number; tables: string[] }[];
}

// ---------------------------------------------------------------------------------------------
// Errors (§3.4): stable string codes, JSON body `{ error: { code, message } }`
// ---------------------------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof AuthError) return new HttpError(e.status, e.code, e.message);
  if (e instanceof CompileError) return new HttpError(400, e.code, e.detail, e.fix ? { fix: e.fix } : {});
  if (e instanceof ParseError) return new HttpError(400, 'PARSE_ERROR', e.message, { pos: e.pos });
  if (e instanceof SourceError) return new HttpError(e.code === 'SOURCE_NO_SECRET' || e.code === 'SOURCE_UNAUTHORIZED' ? 401 : /^SOURCE_(BAD|UNKNOWN|EMPTY|TOO_MANY|PRIVATE)/.test(e.code) ? 400 : 502, e.code, e.message, { fix: e.fix, ...e.extra });
  if (e instanceof SyntaxError) return new HttpError(400, 'BAD_JSON', e.message);
  if (e instanceof Error) {
    const m = /^([A-Z][A-Z0-9_]*):\s*([\s\S]*)$/.exec(e.message);   // engine errors are "CODE: message"
    if (m) {
      const code = m[1];
      const status = /_NO_(MODEL|TABLE|FIELD|ROW|MEMBER)$|^DB_NOT_FOUND$/.test(code) ? 404 : /DUPLICATE/.test(code) ? 409 : 400;
      return new HttpError(status, code, m[2] || e.message);
    }
    return new HttpError(500, 'INTERNAL', e.message);
  }
  return new HttpError(500, 'INTERNAL', String(e));
}

// ---------------------------------------------------------------------------------------------
// Ops: facade methods addressable by name (§3.3 batch; §4 oplog)
// ---------------------------------------------------------------------------------------------

type OpFn = (f: FiniDB, ...args: any[]) => unknown;

function tabular(f: FiniDB, model: string, table: string): Table {
  const t = f.model(model).table(table);
  if (t.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', `${table} is a pivot`);
  return t;
}
function pivot(f: FiniDB, model: string, table: string): Pivot {
  const t = f.model(model).table(table);
  if (t.kind !== 'pivot') throw new HttpError(400, 'SCHEMA_NOT_PIVOT', `${table} is a tabular table`);
  return t;
}

/** Mutations. Every one except createModel takes `(model, table, ...)`, which is what the change log relies on. */
const MUTATIONS: Record<string, OpFn> = {
  createModel: (f, id: string, name?: string) => { const m = f.createModel(id, name); return { id: m.id, name: m.name }; },
  setIterate: (f, model: string, iterate: boolean | { maxIterations?: number; tolerance?: number } | null) => ({ iterate: f.setIterate(model, iterate) ?? null }),
  createTable: (f, model: string, id: string, fields: FieldSpec[] = [], opts: { name?: string; rows?: Record<string, Scalar>[] } = {}) => {
    const t = f.createTable(model, id, fields, opts); return { id: t.id, rowCount: t.rowCount };
  },
  createPivot: (f, model: string, id: string, spec: Parameters<FiniDB['createPivot']>[2]) => { const p = f.createPivot(model, id, spec); return { id: p.id }; },
  createDistinctTable: (f, model: string, id: string, sourceTable: string, sourceField: string) => {
    const t = f.createDistinctTable(model, id, sourceTable, sourceField); return { id: t.id, rowCount: t.rowCount };
  },
  createPeriods: (f, model: string, id: string, spec: PeriodsSpec) => { const t = f.createPeriods(model, id, spec); return { id: t.id, rowCount: t.rowCount }; },
  addField: (f, model: string, table: string, spec: FieldSpec) => { const fl = f.addField(tabular(f, model, table), spec); return { id: fl.id, type: fl.type }; },
  addDim: (f, model: string, table: string, spec: { id: string; table: string; name?: string }) => {
    const p = pivot(f, model, table); const d = p.addDim(spec.id, tabular(f, model, spec.table), spec.name); f.db.touch(); return { id: d.id };
  },
  addMeasure: (f, model: string, table: string, spec: { id: string; type?: FieldType; format?: string; name?: string }) => {
    const p = pivot(f, model, table); const m = p.addMeasure(spec.id, spec.type ?? 'number', spec.name); m.format = spec.format; f.db.touch(); return { id: m.id };
  },
  insertRows: (f, model: string, table: string, rows: Record<string, Scalar>[]) => ({ rowCount: f.insertRows(tabular(f, model, table), rows), inserted: rows.length }),
  upsertRows: (f, model: string, table: string, rows: Record<string, Scalar>[]) => f.upsertRows(tabular(f, model, table), rows),
  setSource: (f, model: string, table: string, source: TableSource | null) => { f.setSource(model, table, source); return { ok: true }; },
  deleteRows: (f, model: string, table: string, ids: string[]) => ({ deleted: f.deleteRows(model, table, ids), rowCount: tabular(f, model, table).rowCount }),
  dropField: (f, model: string, table: string, field: string) => { f.dropField(model, table, field); return { ok: true }; },
  dropTable: (f, model: string, table: string) => { f.dropTable(model, table); return { ok: true }; },
  setRules: (f, model: string, table: string, rules: string | { target: string; when?: Clause[]; formula: string; name?: string }[], opts?: { strict?: boolean; replace?: boolean }) => {
    // Facade gap: setRules assigns the new rule set before its strict smoke test runs, and the smoke
    // test can mark a pre-existing rule 'invalid' when a cell it governs is shadowed by the bad rule.
    // Snapshot the array and each rule's status, and restore on failure, so a 400 leaves the table untouched.
    const t = f.model(model).table(table);
    const savedRules = t.rules, savedStatus = savedRules.map(r => [r.status, r.error] as const);
    const savedComputed = t.kind === 'tabular' ? t.fields.map(fl => fl.computed) : [];
    try { return { rules: f.setRules(model, table, rules, opts) }; }
    catch (e) {
      t.rules = savedRules;
      savedRules.forEach((r, i) => { r.status = savedStatus[i][0]; r.error = savedStatus[i][1]; });
      if (t.kind === 'tabular') t.fields.forEach((fl, i) => fl.computed = savedComputed[i]);
      t.rulesVersion++; f.db.touch();   // the engines key rule caches on these; drop anything built with the bad set
      throw e;
    }
  },
  setValue: (f, model: string, table: string, at: Record<string, string>, measureOrValue: string | Scalar, value?: Scalar) => {
    if (value === undefined) f.setValue(model, table, at, measureOrValue); else f.setValue(model, table, at, measureOrValue, value);
    return { ok: true };
  },
  setCell: (f, model: string, table: string, row: string, field: string, value: Scalar) => { f.setCell(model, table, row, field, value); return { ok: true }; },
  /** PATCH /tables/:table — rename, lineDim / timeDim, measure formats. */
  patchTable: (f, model: string, table: string, patch: { name?: string; lineDim?: string; timeDim?: string; formats?: Record<string, string> }) => {
    const t = f.model(model).table(table);
    if (patch.name !== undefined) t.name = patch.name;
    if (t.kind === 'pivot') {
      if (patch.lineDim !== undefined) t.lineDim = p_dim(t, patch.lineDim);
      if (patch.timeDim !== undefined) t.timeDim = p_dim(t, patch.timeDim);
      for (const [id, fmt] of Object.entries(patch.formats ?? {})) { const m = t.measure(id); if (!m) throw new HttpError(404, 'SCHEMA_NO_MEASURE', `${table}.${id}`); m.format = fmt; }
    } else if (patch.formats) for (const [id, fmt] of Object.entries(patch.formats)) t.field(id).format = fmt;
    f.db.touch();
    return { ok: true };
  },
  /** PATCH /tables/:table/fields/:field — name, format, computed. */
  patchField: (f, model: string, table: string, field: string, patch: { name?: string; format?: string; computed?: boolean }) => {
    const fl = tabular(f, model, table).field(field);
    if (patch.name !== undefined) fl.name = patch.name;
    if (patch.format !== undefined) fl.format = patch.format;
    if (patch.computed !== undefined) fl.computed = patch.computed;
    f.db.touch();
    return { ok: true };
  },
};
function p_dim(p: Pivot, id: string): Dim { const d = p.dim(id); if (!d) throw new HttpError(404, 'SCHEMA_NO_DIM', `${p.id}.${id}`); return d; }

/** Reads allowed inside a batch. */
const READS: Record<string, OpFn> = {
  get: (f, model: string, table: string, at: Record<string, string>, measure?: string) => ({ value: f.get(model, table, at, measure) }),
  getField: (f, model: string, table: string, row: string, field: string) => ({ value: f.getField(model, table, row, field) }),
  query: (f, model: string, q: ServerQuery) => runQuery(f, model, q),
};

// ---------------------------------------------------------------------------------------------
// Query (§3 `POST /db/:db/query`) — markdown via the facade, json as the columnar window of doc 05 §10
// ---------------------------------------------------------------------------------------------

/** The facade's QueryOptions with the wire-level `format` (§3: markdown | json). */
export type ServerQuery = Omit<QueryOptions, 'format'> & { format?: 'markdown' | 'json' | 'grid' };

export function runQuery(f: FiniDB, model: string, q: ServerQuery): string | ColumnarWindow {
  const p = pivot(f, model, q.table);
  for (const id of [...(q.rows ?? []), ...(q.cols ?? [])]) if (!p.dim(id)) throw new HttpError(400, 'QUERY_NO_DIM', `${q.table} has no dim '${id}'`);
  if (q.measure && !p.measure(q.measure)) throw new HttpError(400, 'QUERY_NO_MEASURE', `${q.table} has no measure '${q.measure}'`);
  const { format, ...rest } = q;
  const opts: QueryOptions = { ...rest, rows: q.rows ?? [], cols: q.cols ?? [] };
  if (format === 'json' || format === 'grid') return columnar(f, p, opts);
  return f.query(model, { ...opts, format: 'markdown' }) as string;
}

/** Doc 05 §10: rows/cols as member-id tuples, values row-major, state 0 empty · 1 computed · 2 input · 3 error. */
export interface ColumnarWindow {
  version: number;
  rows: string[][]; cols: string[][];            // member id tuples
  rowLabels: string[][]; colLabels: string[];    // display names
  rowDims: string[]; colDims: string[];          // dim ids on rows / cols
  rowHeaderNames: string[];                      // display names of the row dims
  measure: string;
  values: Value[]; state: number[];              // row-major; state 0 blank · 1 computed · 2 input · 3 error
  formats: (string | undefined)[];               // per row: the row's own format (member `format` attribute or query override), else the measure's
  colFormats?: (string | undefined)[];           // per column: a column member's own format (e.g. a percent line placed on columns); a row's own format wins over it
  measureFormat?: string;                        // the measure's default, so a reader can tell a row's own format from the fallback
  errors: Record<string, { code: string; message?: string; fix?: string }>;
}
/** Columnar window from the facade grid (doc 05 §10). Every non-row/col dim must be paged. */
function columnar(f: FiniDB, p: Pivot, q: QueryOptions): ColumnarWindow {
  for (const d of p.dims) if (!q.rows.includes(d.id) && !q.cols.includes(d.id) && q.pages?.[d.id] === undefined) throw new HttpError(400, 'QUERY_UNPINNED_DIM', `${d.id} must be on rows, cols or pages`);
  const grid = f.query(p.model.id, { ...q, format: 'grid' }) as Grid;
  const measure: Measure = q.measure ? p.measure(q.measure)! : p.defaultMeasure;
  const values: Value[] = [], state: number[] = [], errors: ColumnarWindow['errors'] = {};
  grid.values.forEach((row, r) => row.forEach((v, c) => {
    const idx = values.length;
    values.push(v); state.push(grid.state![r][c]);
    if (isError(v)) errors[idx] = { code: v.error, message: v.message, ...(v.fix ? { fix: v.fix } : {}) };
  }));
  // a paged member's own format (a percent line chosen as the page of a chart card) is the fallback before the measure's
  const pageFormat = p.dims.map(d => { const m = q.pages?.[d.id]; if (m === undefined || q.rows.includes(d.id) || q.cols.includes(d.id) || !d.table.hasField('format')) return undefined; const i = d.table.memberIndex(m); const v = i >= 0 ? d.table.field('format').column.get(i) : null; return v ? String(v) : undefined; }).find(Boolean);
  return {
    version: f.db.version,
    rows: grid.rowIds!, cols: grid.colIds!,
    rowLabels: grid.rowHeaders, colLabels: grid.colHeaders,
    rowDims: q.rows, colDims: q.cols, rowHeaderNames: grid.rowHeaderNames, measure: measure.id,
    values, state, formats: grid.rowFormats!.map(f => f ?? pageFormat ?? measure.format), colFormats: grid.colFormats, measureFormat: pageFormat ?? measure.format, errors,
  };
}
function cartesian(lists: number[][]): number[][] {
  let out: number[][] = [[]];
  for (const l of lists) { const next: number[][] = []; for (const o of out) for (const x of l) next.push([...o, x]); out = next; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Schema description (§3 `GET /db/:db/schema`, `GET /db/:db/tables/:table`)
// ---------------------------------------------------------------------------------------------

function describeRules(t: AnyTable) {
  return t.rules.map(r => ({ order: r.order, target: r.target, when: r.when, formula: r.formula, name: r.name, status: r.status, error: r.error }));
}
export function describeTable(t: AnyTable) {
  if (t.kind === 'tabular') return {
    id: t.id, name: t.name, kind: 'tabular' as const, model: t.model.id, rowCount: t.rowCount, version: t.version,
    fields: t.fields.map(fl => ({ id: fl.id, name: fl.name, type: fl.type, ref: fl.refTable?.id, computed: fl.computed, format: fl.format, ...(t.track && TRACK_FIELDS.some(k => k.id === fl.id) ? { managed: true } : {}) })),
    track: t.track || undefined,
    distinctOf: t.distinctOf ? { table: t.distinctOf.table.id, field: t.distinctOf.field.id } : undefined,
    source: t.source,
    rules: describeRules(t),
  };
  return {
    id: t.id, name: t.name, kind: 'pivot' as const, model: t.model.id, cells: t.totalCells(), version: t.version,
    dims: t.dims.map(d => ({ id: d.id, name: d.name, table: d.table.id, memberCount: d.table.rowCount, members: d.table.rowCount <= 2000 ? Array.from({ length: d.table.rowCount }, (_, i) => d.table.rowId(i)) : undefined, memberNames: d.table.rowCount <= 2000 && d.table.hasField('name') ? Array.from({ length: d.table.rowCount }, (_, i) => { const n = d.table.field('name').column.get(i); return n === null || n === '' ? d.table.rowId(i) : String(n); }) : undefined, attributes: d.table.fields.filter(f => f.id !== 'id').map(f => f.id) })),
    measures: t.measures.map(m => ({ id: m.id, name: m.name, type: m.type, format: m.format })),
    lineDim: t.lineDim?.id, timeDim: t.timeDim?.id,
    rules: describeRules(t),
  };
}
function describeDb(db: DbEntry) {
  return {
    name: db.name, created: db.created, version: db.f.db.version, schemaVersion: db.f.db.schemaVersion,
    models: [...db.f.db.models.values()].map(m => ({ id: m.id, name: m.name, ...(m.iterate ? { iterate: m.iterate } : {}), tables: [...m.tables.values()].map(describeTable) })),
  };
}
/** A row filter for GET /rows: field → value (equals; an array = any of), or { op: value } with gt gte lt lte ne contains. */
export type Where = Record<string, Scalar | Scalar[] | Partial<Record<'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in', Scalar | Scalar[]>>>;
function rowMatches(f: FiniDB, t: Table, i: number, where: Where, q: string | undefined): boolean {
  const id = t.rowId(i);
  const get = (field: string): Value => field === 'id' ? id : f.getField(t.model.id, t.id, id, field);
  const norm = (v: Value): Scalar => (v === null || v === undefined || typeof v === 'object') ? null : v;
  const cmp = (a: Scalar, b: Scalar) => { if (a === null || b === null) return NaN; if (typeof a === 'number' && typeof b === 'number') return a - b; const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
  const eq = (a: Scalar, b: Scalar) => a === b || (a !== null && b !== null && String(a).toLowerCase() === String(b).toLowerCase());
  for (const [field, cond] of Object.entries(where)) {
    if (field !== 'id' && !t.hasField(field)) throw new HttpError(400, 'SCHEMA_NO_FIELD', `${t.id} has no field ${field}`, { fix: `one of: id, ${t.fields.filter(x => x.id !== 'id').map(x => x.id).join(', ')}` });
    const v = norm(get(field));
    const test = (op: string, want: Scalar | Scalar[]): boolean => {
      switch (op) {
        case 'eq': return Array.isArray(want) ? want.some(w => eq(v, w)) : eq(v, want);
        case 'in': return (Array.isArray(want) ? want : [want]).some(w => eq(v, w));
        case 'ne': return Array.isArray(want) ? !want.some(w => eq(v, w)) : !eq(v, want);
        case 'gt': return cmp(v, want as Scalar) > 0; case 'gte': return cmp(v, want as Scalar) >= 0;
        case 'lt': return cmp(v, want as Scalar) < 0; case 'lte': return cmp(v, want as Scalar) <= 0;
        case 'contains': return v !== null && String(v).toLowerCase().includes(String(want).toLowerCase());
        default: throw new HttpError(400, 'BAD_REQUEST', `unknown where operator ${op}`, { fix: 'eq, ne, gt, gte, lt, lte, contains, in' });
      }
    };
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) { for (const [op, want] of Object.entries(cond)) if (!test(op, want as Scalar | Scalar[])) return false; }
    else if (!test('eq', cond as Scalar | Scalar[])) return false;
  }
  if (q) {
    const needle = q.toLowerCase();
    if (!t.fields.some(fl => { const v = get(fl.id); return v !== null && v !== undefined && typeof v !== 'object' && String(v).toLowerCase().includes(needle); })) return false;
  }
  return true;
}
/** The rows of a table, optionally filtered (`where`, free-text `q`) and sorted (`sort`: "field" or "-field", comma-separated); `count` is the filtered total. */
function readRows(f: FiniDB, t: Table, offset: number, limit: number, opts: { where?: Where; q?: string; sort?: string } = {}): { rows: Record<string, Value>[]; count: number } {
  let idx = Array.from({ length: t.rowCount }, (_, i) => i);
  if ((opts.where && Object.keys(opts.where).length) || opts.q) idx = idx.filter(i => rowMatches(f, t, i, opts.where ?? {}, opts.q));
  if (opts.sort) {
    const keys = opts.sort.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ field: s.replace(/^-/, ''), desc: s.startsWith('-') }));
    for (const k of keys) if (k.field !== 'id' && !t.hasField(k.field)) throw new HttpError(400, 'SCHEMA_NO_FIELD', `${t.id} has no field ${k.field}`);
    const val = (i: number, field: string): Scalar => { const v = field === 'id' ? t.rowId(i) : f.getField(t.model.id, t.id, t.rowId(i), field); return v === null || v === undefined || typeof v === 'object' ? null : v; };
    const cache = new Map<string, Scalar>();
    const at = (i: number, field: string) => { const k = `${i}|${field}`; if (!cache.has(k)) cache.set(k, val(i, field)); return cache.get(k)!; };
    idx.sort((a, b) => {
      for (const k of keys) {
        const x = at(a, k.field), y = at(b, k.field);
        if (x === y) continue;
        if (x === null) return 1; if (y === null) return -1;   // blanks last either way
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
        if (c) return k.desc ? -c : c;
      }
      return a - b;
    });
  }
  const out: Record<string, Value>[] = [];
  for (const i of idx.slice(offset, offset + limit)) {
    const row: Record<string, Value> = {};
    for (const fl of t.fields) row[fl.id] = f.getField(t.model.id, t.id, t.rowId(i), fl.id);
    out.push(row);
  }
  return { rows: out, count: idx.length };
}

// ---------------------------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------------------------

type Need = 'none' | 'read' | 'write' | 'admin' | 'super';
interface Ctx {
  req: IncomingMessage; params: Record<string, string>; query: URLSearchParams;
  raw: Buffer; body: any; principal: Principal | undefined; db?: DbEntry;
}
/** A non-JSON or non-200 reply. */
class Reply { constructor(public status: number, public body: string | object, public contentType = 'application/json', public headers: Record<string, string> = {}) {} }
interface Route { method: string; pattern: RegExp; keys: string[]; need: Need; handler: (c: Ctx) => unknown }

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
  return { pattern: new RegExp(`^${src}/?$`), keys };
}
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'LIMIT_BODY', `body exceeds ${limit} bytes`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}
function isLoopbackHost(host: string): boolean { return ['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'].includes(host); }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Minimal multipart/form-data reader: returns the body of the file part (§3 `/load`). */
function multipartFile(raw: Buffer, contentType: string): Buffer {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'LOAD_BAD_MULTIPART', 'multipart boundary missing');
  const boundary = Buffer.from('--' + (m[1] ?? m[2]).trim());
  const parts: { headers: string; body: Buffer }[] = [];
  let pos = raw.indexOf(boundary);
  while (pos >= 0) {
    pos += boundary.length;
    if (raw.subarray(pos, pos + 2).toString() === '--') break;
    const hEnd = raw.indexOf('\r\n\r\n', pos);
    if (hEnd < 0) break;
    const next = raw.indexOf(boundary, hEnd + 4);
    if (next < 0) break;
    parts.push({ headers: raw.subarray(pos, hEnd).toString('utf8'), body: raw.subarray(hEnd + 4, next - 2) });
    pos = next;
  }
  const file = parts.find(p => /filename=/i.test(p.headers)) ?? parts.find(p => /name="(file|csv|data)"/i.test(p.headers)) ?? parts[0];
  if (!file) throw new HttpError(400, 'LOAD_NO_FILE', 'no file part in multipart body');
  return file.body;
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const host = opts.host ?? 'localhost';
  const sourceSecrets = opts.secrets ?? envSecrets();
  const sourceFetch = opts.fetch;
  const allowPrivateSources = opts.allowPrivateSources ?? process.env.FINIDB_ALLOW_PRIVATE_SOURCES === '1';   // the guard is about where sources may point, not where the engine listens
  const dataDir = opts.dataDir ?? join(homedir(), '.finidb');
  const log = opts.log ?? (() => {});
  let requireAuth = opts.requireAuth ?? !isLoopbackHost(host);
  if (!requireAuth && !isLoopbackHost(host)) { requireAuth = true; log(`host ${host} is not loopback: --require-auth forced (doc 07 §2)`); }
  const bodyLimit = opts.bodyLimit ?? 64 * 1024 * 1024;
  const auth = new AuthStore(dataDir);
  const persistence = opts.persistence ?? {};
  const workers = opts.workers !== false;
  const databases = new Map<string, DbEntry>();
  let closing = false;

  // ---- databases ---------------------------------------------------------------------------

  async function openDb(name: string): Promise<DbEntry> {
    const f = (await persistence.open?.(name, join(dataDir, name))) ?? new FiniDB();
    const db: DbEntry = { name, f, created: new Date().toISOString(), changes: [] };
    databases.set(name, db);
    return db;
  }
  for (const name of persistence.list?.(dataDir) ?? []) await openDb(name);

  function dbOf(name: string): DbEntry {
    const db = databases.get(name);
    if (!db) throw new HttpError(404, 'DB_NOT_FOUND', `no database '${name}'`);
    return db;
  }
  /** Tables are addressed without a model in the URL (§3): `?model=`, else the only model, else a unique match. */
  function modelFor(db: DbEntry, table: string, modelId?: string | null): Model {
    if (modelId) return db.f.model(modelId);
    const models = [...db.f.db.models.values()];
    if (models.length === 1) return models[0];
    const hits = models.filter(m => m.hasTable(table));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new HttpError(404, models.length ? 'SCHEMA_NO_TABLE' : 'SCHEMA_NO_MODEL', models.length ? `no table '${table}' in any model` : 'create a model first');
    throw new HttpError(400, 'SCHEMA_AMBIGUOUS_TABLE', `'${table}' exists in models ${hits.map(m => m.id).join(', ')}; pass ?model=`);
  }
  function tableOf(c: Ctx): { model: Model; table: AnyTable } {
    const model = modelFor(c.db!, c.params.table, c.query.get('model') ?? c.body?.model);
    return { model, table: model.table(c.params.table) };
  }

  /** Apply one op to a database: the single choke point for mutations (§3.3, §4). */
  async function applyOp(db: DbEntry, op: Op, user: string): Promise<unknown> {
    if (!op || typeof op.method !== 'string' || !Array.isArray(op.args)) throw new HttpError(400, 'BAD_OP', 'an op is { method, args[] }');
    const mut = Object.hasOwn(MUTATIONS, op.method) ? MUTATIONS[op.method] : undefined;   // hasOwn: never dispatch prototype keys
    const read = Object.hasOwn(READS, op.method) ? READS[op.method] : undefined;
    const fn = mut ?? read;
    if (!fn) throw new HttpError(400, 'UNKNOWN_OP', `unknown op '${op.method}'; known: ${[...Object.keys(MUTATIONS), ...Object.keys(READS)].join(', ')}`);
    const result = fn(db.f, ...op.args);
    if (mut) {
      const tables = op.method === 'createModel' ? [] : typeof op.args[1] === 'string' ? [op.args[1]] : [];
      db.changes.push({ version: db.f.db.version, tables });
      if (db.changes.length > 1000) db.changes.splice(0, db.changes.length - 1000);
      await persistence.append?.(db.name, op, user);
    }
    return result;
  }
  const version = (db: DbEntry) => db.f.db.version;

  // ---- auth ---------------------------------------------------------------------------------

  function principalOf(req: IncomingMessage): Principal | undefined {
    const user = auth.authenticate(req.headers.authorization);
    if (user) return { user, trusted: false };
    if (!requireAuth && isLoopback(req)) return { user: 'local', trusted: true };
    return undefined;
  }
  function authorize(c: Ctx, need: Need) {
    if (need === 'none') return;
    if (!c.principal) throw new HttpError(401, 'AUTH_REQUIRED', 'authentication required', { wwwAuthenticate: 'Basic realm="finidb"' });
    if (need === 'super') { if (!auth.isSuperuser(c.principal)) throw new HttpError(403, 'AUTH_FORBIDDEN', 'superuser required'); return; }
    if (!auth.allows(c.principal, c.params.db, need)) throw new HttpError(403, 'AUTH_FORBIDDEN', `role '${need}' required on database '${c.params.db}'`);
  }

  // ---- routes (§3) ----------------------------------------------------------------------------

  const routes: Route[] = [];
  const route = (method: string, path: string, need: Need, handler: (c: Ctx) => unknown) => routes.push({ method, ...compile(path), need, handler });
  const user = (c: Ctx) => c.principal?.user ?? 'anonymous';
  /** The actor for this request: a trusted caller may name one (`x-finidb-actor`, `x-finidb-actor-name`). */
  function actorOf(c: Ctx): { id: string; name?: string } | undefined {
    const h = c.req.headers;
    const id = typeof h['x-finidb-actor'] === 'string' ? h['x-finidb-actor'].slice(0, 120) : undefined;
    if (id && c.principal?.trusted) return { id, name: typeof h['x-finidb-actor-name'] === 'string' ? h['x-finidb-actor-name'].slice(0, 120) : undefined };
    const u = c.principal?.user;
    return u ? { id: u, name: u } : undefined;
  }

  route('GET', '/health', 'none', () => ({ ok: true, databases: databases.size, uptime: process.uptime() }));

  // auth (§2)
  route('POST', '/auth/token', 'none', c => {
    if (!c.principal || c.principal.trusted && !c.req.headers.authorization) {
      if (c.principal?.trusted) return { token: null, message: 'loopback caller is trusted; no token needed' };
      throw new HttpError(401, 'AUTH_REQUIRED', 'send Basic credentials to obtain a token', { wwwAuthenticate: 'Basic realm="finidb"' });
    }
    return auth.issueToken(c.principal.user);
  });
  route('GET', '/auth/whoami', 'none', c => c.principal ? { user: c.principal.user, trusted: c.principal.trusted, superuser: auth.isSuperuser(c.principal), grants: auth.grantsOf(c.principal.user) } : { user: null });
  route('GET', '/users', 'super', () => ({ users: auth.listUsers() }));
  route('POST', '/users', 'super', c => { auth.createUser(c.body?.name, c.body?.password); return new Reply(201, { name: c.body.name }); });
  route('DELETE', '/users/:user', 'super', c => { auth.deleteUser(c.params.user); return { ok: true }; });
  route('POST', '/grants', 'super', c => {
    const { user: u, db, role } = c.body ?? {};
    if (typeof u !== 'string' || typeof db !== 'string' || !ROLES.includes(role)) throw new HttpError(400, 'BAD_REQUEST', `expected { user, db, role: ${ROLES.join('|')} }`);
    if (db !== '*') dbOf(db);
    auth.grant(u, db, role as Role); return { ok: true };
  });
  route('DELETE', '/grants/:user/:db', 'super', c => { auth.revoke(c.params.user, c.params.db); return { ok: true }; });

  // databases (§2, §3)
  route('GET', '/db', 'none', c => {
    if (!c.principal) throw new HttpError(401, 'AUTH_REQUIRED', 'authentication required', { wwwAuthenticate: 'Basic realm="finidb"' });
    const all = [...databases.values()].filter(db => auth.allows(c.principal!, db.name, 'read'));
    return { databases: all.map(db => ({ name: db.name, created: db.created, version: version(db), models: db.f.db.models.size, role: auth.roleOn(c.principal!, db.name) })) };
  });
  route('POST', '/db', 'none', async c => {
    if (!c.principal) throw new HttpError(401, 'AUTH_REQUIRED', 'authentication required', { wwwAuthenticate: 'Basic realm="finidb"' });
    // any authenticated user may create a database and becomes its admin; unauthenticated loopback is the superuser
    const name = c.body?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new HttpError(400, 'DB_BAD_NAME', 'database name: [A-Za-z0-9_][A-Za-z0-9_.-]{0,63}');
    if (databases.has(name)) throw new HttpError(409, 'DB_DUPLICATE', `database '${name}' exists`);
    const db = await openDb(name);
    if (!c.principal.trusted) auth.grant(c.principal.user, name, 'admin');
    log(`createdb ${name} by ${user(c)}`);
    return new Reply(201, { name: db.name, created: db.created, version: version(db) });
  });
  // A copy of a database: same contents, new name, clean history. Reading the source is enough to copy it;
  // whoever copies it becomes the admin of the copy, exactly as if they had created it.
  route('POST', '/db/:db/copy', 'read', async c => {
    const to = c.body?.to;
    if (typeof to !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(to)) throw new HttpError(400, 'DB_BAD_NAME', 'database name: [A-Za-z0-9_][A-Za-z0-9_.-]{0,63}', { fix: 'send { "to": "<name>" }' });
    if (databases.has(to)) throw new HttpError(409, 'DB_DUPLICATE', `database '${to}' exists`);
    if (!persistence.copy) throw new HttpError(501, 'NOT_SUPPORTED', 'this server keeps no files, so it cannot copy a database');
    const f = await persistence.copy(c.params.db, join(dataDir, c.params.db), to, join(dataDir, to));
    if (!f) throw new HttpError(500, 'COPY_FAILED', `could not copy '${c.params.db}'`);
    const db: DbEntry = { name: to, f, created: new Date().toISOString(), changes: [] };
    databases.set(to, db);
    if (c.principal && !c.principal.trusted) auth.grant(c.principal.user, to, 'admin');
    log(`copydb ${c.params.db} -> ${to} by ${user(c)}`);
    return new Reply(201, { name: to, created: db.created, version: version(db), from: c.params.db });
  });

  route('DELETE', '/db/:db', 'admin', async c => {
    dbOf(c.params.db); databases.delete(c.params.db);
    await persistence.drop?.(c.params.db, join(dataDir, c.params.db));
    log(`dropdb ${c.params.db} by ${user(c)}`);
    return { ok: true };
  });

  // schema & models
  route('GET', '/db/:db/schema', 'read', c => describeDb(c.db!));
  // explain one cell (doc 07 §3): ?table=&measure=&<dim>=<member>… or ?table=&row=&field=
  route('GET', '/db/:db/explain', 'read', c => {
    const tableId = c.query.get('table');
    if (!tableId) throw new HttpError(400, 'BAD_REQUEST', 'explain needs ?table=');
    const model = modelFor(c.db!, tableId, c.query.get('model') ?? undefined);
    const table = model.table(tableId);
    const at: Record<string, string> = {};
    for (const [k, v] of c.query) if (!['table', 'model', 'measure', 'field', 'row'].includes(k)) at[k] = v;
    if (c.query.get('row')) at.id = c.query.get('row')!;
    return c.db!.f.explain(model.id, table.id, at, c.query.get('measure') ?? c.query.get('field') ?? undefined);
  });
  route('GET', '/db/:db/models', 'read', c => ({ models: [...c.db!.f.db.models.values()].map(m => ({ id: m.id, name: m.name, tables: [...m.tables.keys()] })) }));
  /**
   * The workbook is compiled on a worker thread against a snapshot of the database, so a model that takes
   * minutes to render leaves every other request alone. `?inline=1` compiles it here instead, which is what
   * the CLI and the tests want: one process, no threads.
   */
  const exportRoute = async (c: Ctx) => {
    const f = c.db!.f;
    const model = c.query.get('model') ?? c.body?.model ?? (f.db.models.size === 1 ? [...f.db.models.keys()][0] : undefined);
    if (!model) throw new HttpError(400, 'BAD_REQUEST', 'pass ?model= (the database has several models)');
    const dashboards = Array.isArray(c.body?.dashboards) ? c.body.dashboards : undefined;
    const name = `${c.params.db}${f.db.models.size > 1 ? `-${model}` : ''}.xlsx`.replace(/[^A-Za-z0-9._-]+/g, '_');
    const head = (formulas: unknown, values: unknown) => ({ 'Content-Disposition': `attachment; filename="${name}"`, 'X-Finidb-Formulas': String(formulas), 'X-Finidb-Values': String(values) });
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (c.query.get('inline') === '1' || !workers) {
      const { exportWorkbook } = require_export();
      const r = exportWorkbook(f.db, model, { dashboards });
      return new Reply(200, r.buffer as unknown as object, XLSX, head(r.formulas, r.values));
    }
    const t0 = performance.now();
    try {
      const { bytes, meta } = await runJob(`${c.params.db}:xlsx:${model}`, f, { kind: 'exportXlsx', model, opts: { dashboards } });
      log(`export ${c.params.db} on a worker in ${(performance.now() - t0).toFixed(0)}ms by ${user(c)}`);
      return new Reply(200, bytes as unknown as object, XLSX, head(meta.formulas, meta.values));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'JOB_TIMEOUT') throw new HttpError(503, 'EXPORT_TOO_LONG', 'the workbook took too long to compile', { fix: 'export fewer periods or lines, or ask for one model at a time' });
      if (/JOB_EXIT|heap|memory/i.test(msg)) throw new HttpError(503, 'EXPORT_TOO_LARGE', 'the workbook did not fit in memory', { fix: 'export fewer periods or lines' });
      throw e;
    }
  };
  route('GET', '/db/:db/export.xlsx', 'read', exportRoute);
  route('POST', '/db/:db/export.xlsx', 'read', exportRoute);   // body: { model?, dashboards?: DashboardExport[] } — the hosted service adds its dashboards
  route('PATCH', '/db/:db/models/:model', 'write', async c => {
    if (!c.body || !('iterate' in c.body)) throw new HttpError(400, 'BAD_REQUEST', 'body needs { iterate: true | false | { maxIterations, tolerance } }');
    return { ...(await applyOp(c.db!, { method: 'setIterate', args: [c.params.model, c.body.iterate] }, user(c)) as object), version: version(c.db!) };
  });
  route('POST', '/db/:db/models', 'write', async c => new Reply(201, { ...(await applyOp(c.db!, { method: 'createModel', args: [c.body?.id, c.body?.name] }, user(c)) as object), version: version(c.db!) }));

  // tables
  route('GET', '/db/:db/tables', 'read', c => {
    const models = c.query.get('model') ? [c.db!.f.model(c.query.get('model')!)] : [...c.db!.f.db.models.values()];
    return { tables: models.flatMap(m => [...m.tables.values()].map(describeTable)) };
  });
  route('POST', '/db/:db/tables', 'write', async c => {
    const b = c.body ?? {};
    const model: string = b.model ?? (c.db!.f.db.models.size === 1 ? [...c.db!.f.db.models.keys()][0] : undefined);
    if (!model) throw new HttpError(400, 'BAD_REQUEST', 'body needs { model, id, ... }');
    if (typeof b.id !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'body needs an id');
    let op: Op;
    if (b.kind === 'pivot' || b.dims) op = { method: 'createPivot', args: [model, b.id, { dims: b.dims ?? [], measures: b.measures, lineDim: b.lineDim, timeDim: b.timeDim, name: b.name }] };
    else if (b.from?.distinctOf) op = { method: 'createDistinctTable', args: [model, b.id, b.from.distinctOf.table, b.from.distinctOf.field] };
    else if (b.from?.periods) op = { method: 'createPeriods', args: [model, b.id, b.from.periods] };
    else op = { method: 'createTable', args: [model, b.id, b.fields ?? [], { name: b.name, rows: b.rows, track: b.track === true }] };
    const r = await applyOp(c.db!, op, user(c));
    if (op.method === 'createPeriods' && b.rows) await applyOp(c.db!, { method: 'insertRows', args: [model, b.id, b.rows] }, user(c));
    return new Reply(201, { ...(r as object), model, version: version(c.db!) });
  });
  route('GET', '/db/:db/tables/:table', 'read', c => {
    const { model, table } = tableOf(c);
    const d = describeTable(table);
    if (table.kind === 'tabular' && (c.query.has('rows') || c.query.has('limit') || c.query.has('offset'))) {
      const offset = Number(c.query.get('offset') ?? 0), limit = Number(c.query.get('limit') ?? c.query.get('rows') ?? 100);
      return { ...d, rows: readRows(c.db!.f, table, offset, limit).rows, offset, limit, model: model.id };
    }
    return d;
  });
  route('PATCH', '/db/:db/tables/:table', 'write', async c => { const { model } = tableOf(c); await applyOp(c.db!, { method: 'patchTable', args: [model.id, c.params.table, c.body ?? {}] }, user(c)); return { ok: true, version: version(c.db!) }; });
  route('DELETE', '/db/:db/tables/:table', 'write', async c => { const { model, table } = tableOf(c); return { ...(await applyOp(c.db!, { method: 'dropTable', args: [model.id, table.id] }, user(c)) as object), version: version(c.db!) }; });

  // fields / dims / measures
  route('POST', '/db/:db/tables/:table/fields', 'write', async c => {
    const { model, table } = tableOf(c);
    const b = c.body ?? {};
    const op: Op = table.kind === 'pivot'
      ? (b.dim || b.table ? { method: 'addDim', args: [model.id, table.id, b.dim ?? b] } : { method: 'addMeasure', args: [model.id, table.id, b.measure ?? b] })
      : { method: 'addField', args: [model.id, table.id, b] };
    return new Reply(201, { ...(await applyOp(c.db!, op, user(c)) as object), version: version(c.db!) });
  });
  route('PATCH', '/db/:db/tables/:table/fields/:field', 'write', async c => { const { model } = tableOf(c); await applyOp(c.db!, { method: 'patchField', args: [model.id, c.params.table, c.params.field, c.body ?? {}] }, user(c)); return { ok: true, version: version(c.db!) }; });
  route('DELETE', '/db/:db/tables/:table/fields/:field', 'write', async c => { const { model, table } = tableOf(c); return { ...(await applyOp(c.db!, { method: 'dropField', args: [model.id, table.id, c.params.field] }, user(c)) as object), version: version(c.db!) }; });

  // rows
  route('GET', '/db/:db/tables/:table/rows', 'read', c => {
    const { table } = tableOf(c);
    if (table.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', 'pivots are read with /query');
    const offset = Number(c.query.get('offset') ?? 0), limit = Number(c.query.get('limit') ?? 100);
    let where: Where | undefined;
    const w = c.query.get('where');
    if (w) { try { where = JSON.parse(w); } catch { throw new HttpError(400, 'BAD_REQUEST', 'where must be JSON: {"field": value | [values] | {"gt": n}}'); } if (!where || typeof where !== 'object' || Array.isArray(where)) throw new HttpError(400, 'BAD_REQUEST', 'where must be a JSON object'); }
    const r = readRows(c.db!.f, table, offset, limit, { where, q: c.query.get('q') ?? undefined, sort: c.query.get('sort') ?? undefined });
    return { rows: r.rows, offset, limit, rowCount: r.count, total: table.rowCount, version: version(c.db!) };
  });
  route('POST', '/db/:db/tables/:table/rows', 'write', async c => {
    const { model } = tableOf(c);
    const rows = Array.isArray(c.body) ? c.body : c.body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'BAD_REQUEST', 'body is an array of row objects (or { rows: [...] })');
    return new Reply(201, { ...(await applyOp(c.db!, { method: 'insertRows', args: [model.id, c.params.table, rows] }, user(c)) as object), version: version(c.db!) });
  });
  route('PUT', '/db/:db/tables/:table/rows', 'write', async c => {
    // upsert: rows whose id exists get the given fields set; the rest are inserted
    const { model } = tableOf(c);
    const rows = Array.isArray(c.body) ? c.body : c.body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'BAD_REQUEST', 'body is an array of row objects with ids (or { rows: [...] })');
    return { ...(await applyOp(c.db!, { method: 'upsertRows', args: [model.id, c.params.table, rows] }, user(c)) as object), version: version(c.db!) };
  });
  route('PATCH', '/db/:db/tables/:table/rows', 'write', async c => {
    const { model } = tableOf(c);
    const rows: Record<string, Scalar>[] = Array.isArray(c.body) ? c.body : c.body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'BAD_REQUEST', 'body is an array of { id, field: value, ... }');
    let n = 0;
    for (const r of rows) {
      if (typeof r.id !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'each row update needs an id');
      for (const [field, value] of Object.entries(r)) if (field !== 'id') { await applyOp(c.db!, { method: 'setCell', args: [model.id, c.params.table, r.id, field, value] }, user(c)); n++; }
    }
    return { updated: n, version: version(c.db!) };
  });
  route('DELETE', '/db/:db/tables/:table/rows', 'write', async c => {
    const { model, table } = tableOf(c);
    const ids: string[] = Array.isArray(c.body) ? c.body.map(String) : Array.isArray(c.body?.ids) ? c.body.ids.map(String) : (c.query.get('ids') ?? '').split(',').filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'BAD_REQUEST', 'body [ids] or ?ids=a,b');
    return { ...(await applyOp(c.db!, { method: 'deleteRows', args: [model.id, table.id, ids] }, user(c)) as object), version: version(c.db!) };
  });

  // The loader shared by /load (a CSV) and /refresh (rows fetched from a source): plan, validate, apply.
  // Into an existing table: mode append (default) | upsert (ids that exist are updated in place) | replace (the rows
  // become the table: rows not in them are deleted); dryRun plans and validates without writing; addFields adds
  // columns that match no field. Columns match fields by id or name; computed columns are skipped.
  interface LoadOpts { mode?: string; dryRun?: boolean; addFields?: boolean; idColumn?: string; name?: string; user: string }
  async function loadRows(db: DbEntry, modelId: string, tableId: string, csv: ParsedCsv, o: LoadOpts): Promise<Reply> {
    const model = db.f.model(modelId);
    const mode = o.mode ?? 'append';
    if (mode !== 'append' && mode !== 'upsert' && mode !== 'replace') throw new HttpError(400, 'BAD_REQUEST', 'mode is append, upsert or replace');
    const { dryRun = false, addFields = false } = o;
    const exists = model.hasTable(tableId);
    const existing = exists ? model.table(tableId) : undefined;
    if (existing && existing.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', 'cannot load rows into a pivot');
    const candidates: Record<string, Set<string>> = {};
    for (const t of model.tables.values()) if (t.kind === 'tabular' && t !== existing) candidates[t.id] = new Set(t.rowById.keys());
    const types: Record<string, FieldType> = {}, refs: Record<string, string> = {};
    for (const fl of existing?.fields ?? []) { if (fl.type === 'ref') { refs[fl.id] = fl.refTable!.id; types[fl.id] = 'text'; } else types[fl.id] = fl.type; }
    const sample = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? ', …' : '');
    const warnings: string[] = [];
    const errors: { code: string; message: string; fix?: string }[] = [];
    const columns: { header: string; field?: string; action: 'id' | 'match' | 'add' | 'ignore' | 'computed' }[] = [];
    let idColumn = o.idColumn;
    if (existing) {
      // resolve file columns to fields; drop what cannot be loaded
      const resolve = (h: string) => { const s = slug(h), l = h.trim().toLowerCase(); return existing.fields.find(f => f.id === s || f.id === l || f.name.toLowerCase() === l || slug(f.name) === s); };
      const keep: number[] = [];
      csv.header.forEach((h, i) => {
        const f = resolve(h);
        if (!f) { columns.push({ header: h, action: addFields ? 'add' : 'ignore' }); if (addFields) keep.push(i); return; }
        if (f.id === 'id') { columns.push({ header: h, field: 'id', action: 'id' }); csv.header[i] = 'id'; keep.push(i); idColumn = 'id'; return; }
        if (f.computed) { columns.push({ header: h, field: f.id, action: 'computed' }); return; }
        columns.push({ header: h, field: f.id, action: 'match' }); csv.header[i] = f.id; keep.push(i);
      });
      if (keep.length !== csv.header.length) { csv.header = keep.map(i => csv.header[i]); csv.rows = csv.rows.map(r => keep.map(i => r[i] ?? '')); }
      const ignored = columns.filter(x => x.action === 'ignore').map(x => x.header);
      if (ignored.length) warnings.push(`columns not in the table were ignored: ${ignored.join(', ')} (addFields=1 adds them as new fields)`);
      const computed = columns.filter(x => x.action === 'computed').map(x => x.header);
      if (computed.length) warnings.push(`columns computed by rules were skipped: ${computed.join(', ')}`);
      if (!csv.header.length) throw new HttpError(400, 'LOAD_NO_COLUMNS', 'no column of the file matches a field of the table', { columns, fields: existing.fields.map(f => f.id) });
      if (idColumn !== 'id' && mode !== 'append') errors.push({ code: 'LOAD_NO_ID', message: `mode=${mode} needs an id column to match rows`, fix: 'add an id column, or use mode=append' });
    }
    const plan = planLoad(csv, { idColumn, candidates, types, refs });
    if (existing && !plan.idColumn) {
      // generated ids must not collide with the rows already there
      let n = existing.rowCount;
      for (const r of plan.rows) { do n++; while (existing.rowById.has(String(n))); r.id = String(n); }
      plan.warnings = plan.warnings.map(w => w.startsWith('no unique id column') ? `no id column: ids ${plan.rows[0]?.id}…${plan.rows[plan.rows.length - 1]?.id} were generated` : w);
    }
    warnings.push(...plan.warnings);
    const ids = plan.rows.map(r => String(r.id));
    const seen = new Set<string>(), dups: string[] = [];
    for (const id of ids) { if (seen.has(id)) dups.push(id); seen.add(id); }
    if (dups.length) errors.push({ code: 'LOAD_DUPLICATE_ID', message: `${dups.length} ids appear more than once in the file: ${sample(dups)}`, fix: 'make the ids unique' });
    let toInsert = ids.length, toUpdate = 0, toDelete: string[] = [];
    if (existing) {
      const clashes = [...seen].filter(id => existing.rowById.has(id));
      if (mode === 'append') { if (clashes.length) errors.push({ code: 'LOAD_DUPLICATE_ID', message: `${clashes.length} ids already exist in ${existing.id}: ${sample(clashes)}`, fix: 'mode=upsert updates those rows in place; mode=replace makes the file the whole table' }); }
      else { toUpdate = clashes.length; toInsert = ids.length - clashes.length; }
      if (mode === 'replace') toDelete = [...existing.rowById.keys()].filter(id => !seen.has(id));
      for (const f of existing.fields) {
        const col = csv.header.indexOf(f.id);
        if (col < 0 || f.id === 'id') continue;
        if (f.type === 'ref') {
          const target = f.refTable!, bad = new Set<string>();
          for (const r of plan.rows) { const v = r[f.id]; if (v !== null && v !== undefined && !target.rowById.has(String(v))) bad.add(String(v)); }
          if (bad.size) errors.push({ code: 'LOAD_UNKNOWN_REF', message: `${f.id}: ${bad.size} values are not ids of ${target.id}: ${sample([...bad])}`, fix: `load the missing ${target.id} rows first, or fix the values` });
        } else if (f.type === 'number' || f.type === 'date') {
          let bad = 0; const ex: string[] = [];
          for (const r of csv.rows) { const s = (r[col] ?? '').trim(); if (s && coerce(s, f.type) === null) { bad++; if (ex.length < 3) ex.push(s); } }
          if (bad) errors.push({ code: 'LOAD_BAD_VALUE', message: `${f.id}: ${bad} values are not ${f.type === 'date' ? 'dates' : 'numbers'}: ${ex.join(', ')}`, fix: f.type === 'date' ? 'write dates as YYYY-MM-DD' : 'numbers only' });
        }
      }
      const missing = existing.fields.filter(f => f.id !== 'id' && !f.computed && !csv.header.includes(f.id)).map(f => f.id);
      if (missing.length) warnings.push(`fields not in the file keep their values; new rows get blanks: ${missing.join(', ')}`);
      if (toDelete.length) warnings.push(`${toDelete.length} rows not in the file will be deleted; references to them from other tables become blank`);
    }
    const summary = { table: tableId, model: modelId, created: !existing, mode: existing ? mode : 'create', dryRun, ok: errors.length === 0, toInsert, toUpdate, toDelete: toDelete.length, idColumn: plan.idColumn ?? null, columns, fields: plan.fields, profile: plan.profile, warnings, errors };
    if (dryRun) return new Reply(200, { ...summary, rowCount: existing?.rowCount ?? 0, version: version(db) });
    if (errors.length) throw new HttpError(400, errors[0].code, errors[0].message, { fix: errors[0].fix, errors, columns });
    let inserted = 0, updated = 0, changed = 0, deleted = 0, rowCount = 0;
    if (!existing) {
      const r = await applyOp(db, { method: 'createTable', args: [modelId, tableId, plan.fields.map(f => ({ id: f.id, name: f.name, type: f.type === 'ref' ? undefined : f.type, ref: f.ref })), { rows: plan.rows, name: o.name }] }, o.user) as { rowCount: number };
      inserted = plan.rows.length; rowCount = r.rowCount;
    } else {
      for (const col of columns) if (col.action === 'add') {
        const pf = plan.fields.find(f => f.name === col.header);
        if (!pf) continue;
        await applyOp(db, { method: 'addField', args: [modelId, tableId, { id: pf.id, name: pf.name, type: pf.type === 'ref' ? undefined : pf.type, ref: pf.ref }] }, o.user);
        col.field = pf.id;
      }
      if (toDelete.length) deleted = (await applyOp(db, { method: 'deleteRows', args: [modelId, tableId, toDelete] }, o.user) as { deleted: number }).deleted;
      if (mode === 'append') { const r = await applyOp(db, { method: 'insertRows', args: [modelId, tableId, plan.rows] }, o.user) as { rowCount: number }; inserted = plan.rows.length; rowCount = r.rowCount; }
      else { const r = await applyOp(db, { method: 'upsertRows', args: [modelId, tableId, plan.rows] }, o.user) as { inserted: number; updated: number; changed: number; rowCount: number }; inserted = r.inserted; updated = r.updated; changed = r.changed; rowCount = r.rowCount; }
    }
    return new Reply(201, { ...summary, inserted, updated, changed, deleted, rowCount, version: version(db) });
  }
  const modelIdOf = (c: Ctx, explicit?: string) => {
    const db = c.db!;
    const id = explicit ?? c.query.get('model') ?? c.body?.model ?? (db.f.db.models.size === 1 ? [...db.f.db.models.keys()][0] : undefined);
    if (!id) throw new HttpError(400, 'BAD_REQUEST', 'pass ?model= (the database has several models)');
    return String(id);
  };
  const flagOf = (c: Ctx, k: string) => { const v = c.query.get(k) ?? c.body?.[k]; return v === true || v === '1' || v === 'true'; };
  const optOf = (c: Ctx, k: string): string | undefined => { const v = c.query.get(k) ?? c.body?.[k]; return v === undefined || v === null ? undefined : String(v); };

  // CSV load: raw text/csv body, multipart file part, or { csv: "..." } (§3 `/load`); returns the plan and the profile
  route('POST', '/db/:db/tables/:table/load', 'write', async c => {
    const ct = String(c.req.headers['content-type'] ?? '');
    const text = ct.startsWith('multipart/form-data') ? multipartFile(c.raw, ct).toString('utf8') : typeof c.body?.csv === 'string' ? c.body.csv : c.raw.toString('utf8');
    if (!text.trim()) throw new HttpError(400, 'LOAD_EMPTY', 'no CSV content');
    const csv = parseCsv(text, optOf(c, 'delimiter') ?? ',');
    return loadRows(c.db!, modelIdOf(c), c.params.table, csv, { mode: optOf(c, 'mode'), dryRun: flagOf(c, 'dryRun'), addFields: flagOf(c, 'addFields'), idColumn: optOf(c, 'idColumn'), name: optOf(c, 'name'), user: user(c) });
  });

  // Linked tables (src/source): a source is saved on the table; refresh fetches it and loads the rows.
  //   POST /refresh  { source?, secrets?, name?, dryRun? }  — saves `source` if given (creating the table on first fetch), fetches, loads
  //   PUT  /source   { source }                             — link or edit without fetching;  DELETE /source — unlink
  const sourceOf = (body: unknown): TableSource => {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'source is an object: { preset: { id, params } } or { url, path, map, id, … }');
    const { fetchedAt: _a, status: _b, error: _c, fetchedRows: _d, ...src } = body as TableSource;
    requestsOf(src);   // validates the shape (throws SourceError)
    return src;
  };
  const cleanSource = (s: TableSource | undefined) => s ? { ...s } : undefined;
  route('PUT', '/db/:db/tables/:table/source', 'write', async c => {
    const { model, table } = tableOf(c);
    if (table.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', 'only data tables can be linked');
    const src = sourceOf(c.body?.source ?? c.body);
    const prev = table.source;
    await applyOp(c.db!, { method: 'setSource', args: [model.id, table.id, { ...src, fetchedAt: prev?.fetchedAt, status: prev?.status, fetchedRows: prev?.fetchedRows }] }, user(c));
    return { ok: true, source: cleanSource(table.source), secrets: secretNamesOf(src), version: version(c.db!) };
  });
  route('DELETE', '/db/:db/tables/:table/source', 'write', async c => {
    const { model, table } = tableOf(c);
    await applyOp(c.db!, { method: 'setSource', args: [model.id, table.id, null] }, user(c));
    return { ok: true, version: version(c.db!) };
  });
  route('POST', '/db/:db/tables/:table/refresh', 'write', async c => {
    const db = c.db!;
    const modelId = modelIdOf(c);
    const model = db.f.model(modelId);
    const existing = model.hasTable(c.params.table) ? model.table(c.params.table) : undefined;
    if (existing && existing.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', 'only data tables can be linked');
    const src = c.body?.source ? sourceOf(c.body.source) : existing?.source;
    if (!src) throw new HttpError(400, 'SOURCE_NONE', `${c.params.table} is not linked to a source`, { fix: 'pass { source } to link it, or PUT …/source first' });
    const dryRun = flagOf(c, 'dryRun');
    const secrets = { ...(sourceSecrets), ...(c.body?.secrets && typeof c.body.secrets === 'object' ? c.body.secrets : {}) };
    let fetched: FetchedRows;
    try { fetched = await fetchSource(src, { secrets, fetch: sourceFetch, allowPrivate: allowPrivateSources }); }
    catch (e) {
      if (!(e instanceof SourceError)) throw e;
      if (existing?.source && !dryRun) await applyOp(db, { method: 'setSource', args: [modelId, existing.id, { ...(c.body?.source ? src : existing.source), fetchedAt: existing.source.fetchedAt, fetchedRows: existing.source.fetchedRows, status: 'error', error: `${e.code}: ${e.message}` }] }, user(c));
      throw new HttpError(e.code === 'SOURCE_NO_SECRET' || e.code === 'SOURCE_UNAUTHORIZED' ? 401 : e.code.startsWith('SOURCE_BAD') || e.code === 'SOURCE_NONE' ? 400 : 502, e.code, e.message, { fix: e.fix, ...e.extra });
    }
    if (!fetched.rows.length) throw new HttpError(502, 'SOURCE_EMPTY_RESULT', 'the source returned no records', { fix: 'check the tickers, the path to the records, or the plan the key belongs to', warnings: fetched.warnings });
    // rows -> csv matrix so the shared loader plans, validates and applies them like a file
    const header = ['id', ...fetched.columns];
    const cell = (v: Scalar | undefined) => v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    const csv: ParsedCsv = { header, rows: fetched.rows.map(r => header.map(h => cell(r[h]))) };
    const mode = src.mode ?? 'replace';
    const reply = await loadRows(db, modelId, c.params.table, csv, { mode: existing ? mode : 'append', dryRun, addFields: true, idColumn: 'id', name: optOf(c, 'name'), user: user(c) });
    const body = reply.body as Record<string, unknown>;
    if (!dryRun) {
      const stamp: TableSource = { ...src, fetchedAt: new Date().toISOString(), status: 'ok', error: undefined, fetchedRows: fetched.rows.length };
      await applyOp(db, { method: 'setSource', args: [modelId, c.params.table, stamp] }, user(c));
    }
    return new Reply(reply.status, { ...body, source: cleanSource(dryRun ? src : (model.table(c.params.table) as Table).source), requests: fetched.requests, warnings: [...(body.warnings as string[]), ...fetched.warnings], version: version(db) });
  });
  route('GET', '/source-presets', 'none', () => ({ presets: describePresets() }));

  // rules (§3): PUT replaces, POST appends; body is rule text (text/plain) or { rules: text | [{target, when, formula}] }
  const rulesOf = (c: Ctx) => {
    const ct = String(c.req.headers['content-type'] ?? '');
    if (ct.startsWith('text/')) return c.raw.toString('utf8');
    if (typeof c.body === 'string' || Array.isArray(c.body)) return c.body;
    if (c.body && (typeof c.body.rules === 'string' || Array.isArray(c.body.rules))) return c.body.rules;
    throw new HttpError(400, 'BAD_REQUEST', 'send rule text (text/plain) or { rules: "..." | [{ target, when, formula }] }');
  };
  route('GET', '/db/:db/tables/:table/rules', 'read', c => ({ rules: describeRules(tableOf(c).table) }));
  route('PUT', '/db/:db/tables/:table/rules', 'write', async c => {
    const { model } = tableOf(c);
    const r = await applyOp(c.db!, { method: 'setRules', args: [model.id, c.params.table, rulesOf(c), { replace: true, strict: c.body?.strict ?? c.query.get('strict') !== 'false' }] }, user(c));
    return { ...(r as object), version: version(c.db!) };
  });
  route('POST', '/db/:db/tables/:table/rules', 'write', async c => {
    const { model } = tableOf(c);
    const r = await applyOp(c.db!, { method: 'setRules', args: [model.id, c.params.table, rulesOf(c), { replace: false, strict: c.body?.strict ?? c.query.get('strict') !== 'false' }] }, user(c));
    return new Reply(201, { ...(r as object), version: version(c.db!) });
  });
  // edit / delete one rule by its `order`: rebuilt through setRules(replace) since the facade has no per-rule ops
  const rebuildRules = async (c: Ctx, edit: (rules: { target: string; when: Clause[]; formula: string; name?: string }[], i: number) => void) => {
    const { model, table } = tableOf(c);
    const i = Number(c.params.rule);
    if (!Number.isInteger(i) || i < 0 || i >= table.rules.length) throw new HttpError(404, 'RULE_NOT_FOUND', `no rule #${c.params.rule} on ${table.id}`);
    const rules = table.rules.map(r => ({ target: r.target, when: r.when, formula: r.formula, name: r.name }));
    edit(rules, i);
    const r = await applyOp(c.db!, { method: 'setRules', args: [model.id, table.id, rules, { replace: true }] }, user(c));
    return { ...(r as object), version: version(c.db!) };
  };
  route('PATCH', '/db/:db/tables/:table/rules/:rule', 'write', c => rebuildRules(c, (rules, i) => {
    const b = c.body ?? {};
    if (typeof b.formula === 'string') rules[i].formula = b.formula;
    if (typeof b.target === 'string') rules[i].target = b.target;
    if (Array.isArray(b.when)) rules[i].when = b.when;
    if (typeof b.name === 'string') rules[i].name = b.name;
    if (typeof b.order === 'number' && b.order !== i) { const [r] = rules.splice(i, 1); rules.splice(Math.max(0, Math.min(rules.length, b.order)), 0, r); }
  }));
  route('DELETE', '/db/:db/tables/:table/rules/:rule', 'write', c => rebuildRules(c, (rules, i) => { rules.splice(i, 1); }));

  // cells (§3): [{ table, at: {dim: member}, measure?, value }] → setValue; { table, row, field, value } → setCell
  route('POST', '/db/:db/cells', 'write', async c => {
    const items = Array.isArray(c.body) ? c.body : c.body ? [c.body] : [];
    if (!items.length) throw new HttpError(400, 'BAD_REQUEST', 'body is a cell write or an array of them');
    for (const it of items) {
      if (typeof it?.table !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'each cell write needs a table');
      const model = modelFor(c.db!, it.table, it.model);
      const value = it.clear ? null : it.value ?? null;
      if (it.at) await applyOp(c.db!, { method: 'setValue', args: it.measure ? [model.id, it.table, it.at, it.measure, value] : [model.id, it.table, it.at, value] }, user(c));
      else if (it.row !== undefined && it.field) await applyOp(c.db!, { method: 'setCell', args: [model.id, it.table, String(it.row), it.field, value] }, user(c));
      else throw new HttpError(400, 'BAD_REQUEST', 'a cell write is { table, at, measure?, value } or { table, row, field, value }');
    }
    return { applied: items.length, version: version(c.db!) };
  });
  // read one cell: ?table=&measure=&<dim>=<member>...  or ?table=&row=&field=
  route('GET', '/db/:db/cells', 'read', c => {
    const table = c.query.get('table');
    if (!table) throw new HttpError(400, 'BAD_REQUEST', '?table= required');
    const model = modelFor(c.db!, table, c.query.get('model'));
    let v: Value;
    if (c.query.has('row') && c.query.has('field')) v = c.db!.f.getField(model.id, table, c.query.get('row')!, c.query.get('field')!);
    else {
      const at: Record<string, string> = {};
      for (const [k, val] of c.query) if (!['table', 'model', 'measure'].includes(k)) at[k] = val;
      v = c.db!.f.get(model.id, table, at, c.query.get('measure') ?? undefined);
    }
    return isError(v) ? { value: null, error: { code: v.error, message: v.message }, version: version(c.db!) } : { value: v, version: version(c.db!) };
  });

  // query (§3 `POST /db/:db/query`): facade QueryOptions + format markdown|json
  route('POST', '/db/:db/query', 'read', c => {
    const q = c.body ?? {};
    if (typeof q.table !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'body needs { table, rows, cols, ... }');
    const model = modelFor(c.db!, q.table, q.model);
    const r = runQuery(c.db!.f, model.id, q);
    if (typeof r !== 'string') return r;
    if (String(c.req.headers.accept ?? '').includes('application/json')) return { markdown: r, version: version(c.db!) };
    return new Reply(200, r, 'text/markdown; charset=utf-8');
  });

  // batch (§3.3): [{ method, args }] applied in order. Not atomic yet: on failure the response names the failing index.
  route('POST', '/db/:db/batch', 'none', async c => {
    const ops: Op[] = Array.isArray(c.body) ? c.body : c.body?.ops;
    if (!Array.isArray(ops)) throw new HttpError(400, 'BAD_REQUEST', 'body is an array of { method, args }');
    authorize(c, ops.some(o => o && o.method in MUTATIONS) ? 'write' : 'read');
    const results: unknown[] = [];
    for (let i = 0; i < ops.length; i++) {
      try { results.push(await applyOp(c.db!, ops[i], user(c))); }
      catch (e) { const he = toHttpError(e); throw new HttpError(he.status, he.code, `op #${i} (${ops[i]?.method}): ${he.message}`, { ...he.extra, index: i, applied: i, results }); }
    }
    return { results, version: version(c.db!) };
  });

  // changes (§3.2): long-poll up to 25 s until the database version moves past `since`
  /**
   * `GET /db/:db/history` — what changed, newest first: `{ seq, ts, op, by, byName, table, rows }`.
   * `table` and `row` narrow it; `limit` caps the answer (200 by default). The log is the record of every
   * change ever made, including the ones since overwritten, which a table's own columns cannot show.
   */
  route('GET', '/db/:db/history', 'read', c => {
    const dir = join(dataDir, c.params.db);
    const limit = Math.min(1000, Math.max(1, Number(c.query.get('limit') ?? 200)));
    const table = c.query.get('table') ?? undefined, row = c.query.get('row') ?? undefined;
    let records: OpRecord[];
    try { records = readOplog(dir); } catch { records = []; }
    const out: Record<string, unknown>[] = [];
    for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = records[i];
      const a = (r.args ?? {}) as Record<string, unknown>;
      const t = typeof a.table === 'string' ? a.table : typeof a.id === 'string' && r.op.startsWith('create') ? a.id : undefined;
      if (table && t !== table) continue;
      const rows = Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : undefined;
      const ids = rows ? rows.map(x => (x?.id === undefined || x?.id === null ? null : String(x.id))).filter((x): x is string => !!x) : typeof a.rowId === 'string' ? [a.rowId] : Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : [];
      if (row && !ids.includes(row)) continue;
      out.push({
        seq: r.seq, ts: r.ts, op: r.op, ...(r.by ? { by: r.by, byName: r.byName ?? r.by } : {}),
        ...(t ? { table: t } : {}), ...(typeof a.model === 'string' ? { model: a.model } : {}),
        ...(ids.length ? { rows: ids.slice(0, 50), rowCount: ids.length } : {}),
        ...(typeof a.field === 'object' && a.field ? { field: (a.field as { id?: string }).id } : typeof a.fieldId === 'string' ? { field: a.fieldId } : {}),
        ...(a.value !== undefined ? { value: a.value } : {}),
        ...(typeof a.count === 'number' ? { rowCount: a.count } : {}),
      });
    }
    return { history: out, total: records.length };
  });

  route('GET', '/db/:db/changes', 'read', async c => {
    const db = c.db!;
    const since = Number(c.query.get('since') ?? -1);
    const timeout = Math.min(25000, Number(c.query.get('timeout') ?? 25000));
    const deadline = Date.now() + timeout;
    while (version(db) <= since && Date.now() < deadline && !closing) await sleep(50);
    const v = version(db);
    const tables = [...new Set(db.changes.filter(ch => ch.version > since).flatMap(ch => ch.tables))];
    return { version: v, changed: v > since, tables };
  });

  // ---- dispatch ------------------------------------------------------------------------------

  const server: Server = createServer(async (req, res) => {
    const t0 = performance.now();
    let engineMs = 0;
    const send = (status: number, body: string | object, contentType = 'application/json', headers: Record<string, string> = {}) => {
      const payload = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload),
        'Server-Timing': `engine;dur=${engineMs.toFixed(2)}, total;dur=${(performance.now() - t0).toFixed(2)}`,
        ...headers,
      });
      res.end(payload);
    };
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    try {
      let match: Route | undefined, params: Record<string, string> = {};
      let pathKnown = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        pathKnown = true;
        if (r.method !== method) continue;
        match = r; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); break;
      }
      if (!match) throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', `${method} ${url.pathname}`);
      const raw = await readBody(req, bodyLimit);
      const ct = String(req.headers['content-type'] ?? '');
      let body: any = undefined;
      if (raw.length && (ct.includes('json') || (!ct && /^[\s]*[\[{"]/.test(raw.subarray(0, 32).toString())))) body = JSON.parse(raw.toString('utf8'));
      const c: Ctx = { req, params, query: url.searchParams, raw, body, principal: principalOf(req) };
      const t1 = performance.now();
      try {
        if (params.db !== undefined) { c.db = dbOf(params.db); authorize(c, match.need); }
        else authorize(c, match.need);
        // Who is making this change: the authenticated user, or the person the trusted caller names on its behalf
        // (the hosted site speaks for whoever is signed in). Every record written during this request carries it.
        if (c.db) c.db.f.actor = actorOf(c);
        const result = await match.handler(c);
        if (result instanceof Reply) send(result.status, result.body, result.contentType, result.headers);
        else send(200, result ?? { ok: true });
      } finally { engineMs = performance.now() - t1; }
      log(`${method} ${url.pathname} ${res.statusCode} ${engineMs.toFixed(1)}ms ${user(c)}`);
    } catch (e) {
      const he = toHttpError(e);
      const { wwwAuthenticate, ...extra } = he.extra;
      const headers: Record<string, string> = wwwAuthenticate ? { 'WWW-Authenticate': String(wwwAuthenticate) } : {};
      if (he.status >= 500) log(`ERROR ${method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      send(he.status, { error: { code: he.code, message: he.message, ...extra } }, 'application/json', headers);
    }
  });
  server.keepAliveTimeout = 30000;

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 5488, host, () => { server.off('error', reject); resolve(); }); });
  const addr = server.address() as AddressInfo;
  const urlHost = addr.family === 'IPv6' && host !== 'localhost' ? `[${addr.address}]` : host;
  log(`finidb listening on http://${urlHost}:${addr.port} (data: ${dataDir}, auth: ${requireAuth ? 'required' : 'loopback trusted'})`);

  return {
    port: addr.port, host, url: `http://${urlHost}:${addr.port}`, auth, databases,
    close: () => new Promise<void>(resolve => { closing = true; server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** The route table, for `finidb serve --routes` and the docs. */
export const ROUTES = [
  ['GET', '/health', 'none'], ['POST', '/auth/token', 'basic'], ['GET', '/auth/whoami', 'none'],
  ['GET', '/users', 'super'], ['POST', '/users', 'super'], ['DELETE', '/users/:user', 'super'], ['POST', '/grants', 'super'], ['DELETE', '/grants/:user/:db', 'super'],
  ['GET', '/db', 'auth'], ['POST', '/db', 'auth'], ['DELETE', '/db/:db', 'admin'],
  ['GET', '/db/:db/schema', 'read'], ['GET', '/db/:db/explain', 'read'], ['GET', '/db/:db/models', 'read'], ['POST', '/db/:db/models', 'write'],
  ['GET', '/db/:db/tables', 'read'], ['POST', '/db/:db/tables', 'write'], ['GET', '/db/:db/tables/:table', 'read'], ['PATCH', '/db/:db/tables/:table', 'write'], ['DELETE', '/db/:db/tables/:table', 'write'],
  ['POST', '/db/:db/tables/:table/fields', 'write'], ['PATCH', '/db/:db/tables/:table/fields/:field', 'write'], ['DELETE', '/db/:db/tables/:table/fields/:field', 'write'],
  ['GET', '/db/:db/tables/:table/rows', 'read'], ['POST', '/db/:db/tables/:table/rows', 'write'], ['PUT', '/db/:db/tables/:table/rows', 'write'], ['PATCH', '/db/:db/tables/:table/rows', 'write'], ['DELETE', '/db/:db/tables/:table/rows', 'write'],
  ['POST', '/db/:db/tables/:table/load', 'write'], ['POST', '/db/:db/tables/:table/refresh', 'write'], ['PUT', '/db/:db/tables/:table/source', 'write'], ['DELETE', '/db/:db/tables/:table/source', 'write'], ['GET', '/source-presets', 'none'],
  ['GET', '/db/:db/tables/:table/rules', 'read'], ['PUT', '/db/:db/tables/:table/rules', 'write'], ['POST', '/db/:db/tables/:table/rules', 'write'], ['PATCH', '/db/:db/tables/:table/rules/:rule', 'write'], ['DELETE', '/db/:db/tables/:table/rules/:rule', 'write'],
  ['POST', '/db/:db/cells', 'write'], ['GET', '/db/:db/cells', 'read'],
  ['POST', '/db/:db/query', 'read'], ['POST', '/db/:db/batch', 'read|write'], ['GET', '/db/:db/changes', 'read'],
] as const;
