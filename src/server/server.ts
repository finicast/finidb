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
import { FiniDB, CompileError, ParseError, isError } from '../index.js';
import type { QueryOptions, FieldSpec, PeriodsSpec, Scalar, Value, Grid, Clause } from '../index.js';
import type { AnyTable, Table, Pivot, Dim, Measure, Model } from '../schema/schema.js';
import { parseCsv, planLoad } from '../store/csv.js';
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
}

export interface ServerOptions {
  port?: number;                 // default 5488; 0 = ephemeral
  host?: string;                 // default 'localhost'
  dataDir?: string;              // default ~/.finidb; holds auth.json (and, later, databases)
  requireAuth?: boolean;         // default: host is not loopback (§2); forced on for non-loopback hosts
  persistence?: PersistenceHook;
  log?: (line: string) => void;  // request log; silent by default
  bodyLimit?: number;            // bytes; default 64 MiB (§6 "upload size caps")
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
  formats: (string | undefined)[];               // per row
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
  return {
    version: f.db.version,
    rows: grid.rowIds!, cols: grid.colIds!,
    rowLabels: grid.rowHeaders, colLabels: grid.colHeaders,
    rowDims: q.rows, colDims: q.cols, rowHeaderNames: grid.rowHeaderNames, measure: measure.id,
    values, state, formats: grid.formats!.map(fr => fr[0]), errors,
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
    fields: t.fields.map(fl => ({ id: fl.id, name: fl.name, type: fl.type, ref: fl.refTable?.id, computed: fl.computed, format: fl.format })),
    distinctOf: t.distinctOf ? { table: t.distinctOf.table.id, field: t.distinctOf.field.id } : undefined,
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
function readRows(f: FiniDB, t: Table, offset: number, limit: number): Record<string, Value>[] {
  const out: Record<string, Value>[] = [];
  for (let i = offset; i < Math.min(t.rowCount, offset + limit); i++) {
    const row: Record<string, Value> = {};
    for (const fl of t.fields) row[fl.id] = f.getField(t.model.id, t.id, t.rowId(i), fl.id);
    out.push(row);
  }
  return out;
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
  const dataDir = opts.dataDir ?? join(homedir(), '.finidb');
  const log = opts.log ?? (() => {});
  let requireAuth = opts.requireAuth ?? !isLoopbackHost(host);
  if (!requireAuth && !isLoopbackHost(host)) { requireAuth = true; log(`host ${host} is not loopback: --require-auth forced (doc 07 §2)`); }
  const bodyLimit = opts.bodyLimit ?? 64 * 1024 * 1024;
  const auth = new AuthStore(dataDir);
  const persistence = opts.persistence ?? {};
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
  route('GET', '/db/:db/export.xlsx', 'read', c => {
    const f = c.db!.f;
    const model = c.query.get('model') ?? (f.db.models.size === 1 ? [...f.db.models.keys()][0] : undefined);
    if (!model) throw new HttpError(400, 'BAD_REQUEST', 'pass ?model= (the database has several models)');
    const { exportWorkbook } = require_export();
    const r = exportWorkbook(f.db, model);
    const name = `${c.params.db}${f.db.models.size > 1 ? `-${model}` : ''}.xlsx`.replace(/[^A-Za-z0-9._-]+/g, '_');
    return new Reply(200, r.buffer as unknown as object, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': `attachment; filename="${name}"`, 'X-Finidb-Formulas': String(r.formulas), 'X-Finidb-Values': String(r.values) });
  });
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
    else op = { method: 'createTable', args: [model, b.id, b.fields ?? [], { name: b.name, rows: b.rows }] };
    const r = await applyOp(c.db!, op, user(c));
    if (op.method === 'createPeriods' && b.rows) await applyOp(c.db!, { method: 'insertRows', args: [model, b.id, b.rows] }, user(c));
    return new Reply(201, { ...(r as object), model, version: version(c.db!) });
  });
  route('GET', '/db/:db/tables/:table', 'read', c => {
    const { model, table } = tableOf(c);
    const d = describeTable(table);
    if (table.kind === 'tabular' && (c.query.has('rows') || c.query.has('limit') || c.query.has('offset'))) {
      const offset = Number(c.query.get('offset') ?? 0), limit = Number(c.query.get('limit') ?? c.query.get('rows') ?? 100);
      return { ...d, rows: readRows(c.db!.f, table, offset, limit), offset, limit, model: model.id };
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
    return { rows: readRows(c.db!.f, table, offset, limit), offset, limit, rowCount: table.rowCount, version: version(c.db!) };
  });
  route('POST', '/db/:db/tables/:table/rows', 'write', async c => {
    const { model } = tableOf(c);
    const rows = Array.isArray(c.body) ? c.body : c.body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'BAD_REQUEST', 'body is an array of row objects (or { rows: [...] })');
    return new Reply(201, { ...(await applyOp(c.db!, { method: 'insertRows', args: [model.id, c.params.table, rows] }, user(c)) as object), version: version(c.db!) });
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

  // CSV load: raw text/csv body, multipart file part, or { csv: "..." } (§3 `/load`); returns the profile
  route('POST', '/db/:db/tables/:table/load', 'write', async c => {
    const ct = String(c.req.headers['content-type'] ?? '');
    const text = ct.startsWith('multipart/form-data') ? multipartFile(c.raw, ct).toString('utf8') : typeof c.body?.csv === 'string' ? c.body.csv : c.raw.toString('utf8');
    if (!text.trim()) throw new HttpError(400, 'LOAD_EMPTY', 'no CSV content');
    const db = c.db!;
    const modelId = c.query.get('model') ?? c.body?.model ?? (db.f.db.models.size === 1 ? [...db.f.db.models.keys()][0] : undefined);
    if (!modelId) throw new HttpError(400, 'BAD_REQUEST', 'pass ?model= (the database has several models)');
    const model = db.f.model(modelId);
    const csv = parseCsv(text, c.query.get('delimiter') ?? c.body?.delimiter ?? ',');
    const exists = model.hasTable(c.params.table);
    const existing = exists ? model.table(c.params.table) : undefined;
    if (existing && existing.kind !== 'tabular') throw new HttpError(400, 'SCHEMA_NOT_TABULAR', 'cannot load rows into a pivot');
    const candidates: Record<string, Set<string>> = {};
    for (const t of model.tables.values()) if (t.kind === 'tabular' && t !== existing) candidates[t.id] = new Set(t.rowById.keys());
    const types: Record<string, FieldType> = {}, refs: Record<string, string> = {};
    for (const fl of existing?.fields ?? []) { if (fl.type === 'ref') { refs[fl.id] = fl.refTable!.id; types[fl.id] = 'text'; } else types[fl.id] = fl.type; }
    const plan = planLoad(csv, { idColumn: c.query.get('idColumn') ?? c.body?.idColumn ?? undefined, candidates, types, refs });
    const op: Op = existing
      ? { method: 'insertRows', args: [modelId, c.params.table, plan.rows] }
      : { method: 'createTable', args: [modelId, c.params.table, plan.fields.map(f => ({ id: f.id, name: f.name, type: f.type === 'ref' ? undefined : f.type, ref: f.ref })), { rows: plan.rows, name: c.query.get('name') ?? c.body?.name ?? undefined }] };
    const r = await applyOp(db, op, user(c)) as { rowCount: number };
    return new Reply(201, { table: c.params.table, model: modelId, created: !existing, inserted: plan.rows.length, rowCount: r.rowCount, idColumn: plan.idColumn, fields: plan.fields, profile: plan.profile, warnings: plan.warnings, version: version(db) });
  });

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
  ['GET', '/db/:db/tables/:table/rows', 'read'], ['POST', '/db/:db/tables/:table/rows', 'write'], ['PATCH', '/db/:db/tables/:table/rows', 'write'], ['DELETE', '/db/:db/tables/:table/rows', 'write'],
  ['POST', '/db/:db/tables/:table/load', 'write'],
  ['GET', '/db/:db/tables/:table/rules', 'read'], ['PUT', '/db/:db/tables/:table/rules', 'write'], ['POST', '/db/:db/tables/:table/rules', 'write'], ['PATCH', '/db/:db/tables/:table/rules/:rule', 'write'], ['DELETE', '/db/:db/tables/:table/rules/:rule', 'write'],
  ['POST', '/db/:db/cells', 'write'], ['GET', '/db/:db/cells', 'read'],
  ['POST', '/db/:db/query', 'read'], ['POST', '/db/:db/batch', 'read|write'], ['GET', '/db/:db/changes', 'read'],
] as const;
