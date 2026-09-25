/**
 * Reading the rows of a data table: the filter, the sort and the page a data card asks for. Like the columnar
 * window, it is built from the facade alone, so the same code answers `GET /rows` on the server and fills a
 * card inside a browser tab holding the same model.
 */
import type { FiniDB } from '../core.js';
import type { Table } from '../schema/schema.js';
import type { Scalar, Value } from '../store/column.js';

/** What a caller did wrong: an unknown field or operator. The server turns these into 400s. */
export class RowsError extends Error {
  constructor(readonly code: string, message: string, readonly fix?: string) { super(message); }
}

/** A row filter for GET /rows: field → value (equals; an array = any of), or { op: value } with gt gte lt lte ne contains. */
export type Where = Record<string, Scalar | Scalar[] | Partial<Record<'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in', Scalar | Scalar[]>>>;
export function rowMatches(f: FiniDB, t: Table, i: number, where: Where, q: string | undefined): boolean {
  const id = t.rowId(i);
  const get = (field: string): Value => field === 'id' ? id : f.getField(t.model.id, t.id, id, field);
  const norm = (v: Value): Scalar => (v === null || v === undefined || typeof v === 'object') ? null : v;
  const cmp = (a: Scalar, b: Scalar) => { if (a === null || b === null) return NaN; if (typeof a === 'number' && typeof b === 'number') return a - b; const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
  const eq = (a: Scalar, b: Scalar) => a === b || (a !== null && b !== null && String(a).toLowerCase() === String(b).toLowerCase());
  for (const [field, cond] of Object.entries(where)) {
    if (field !== 'id' && !t.hasField(field)) throw new RowsError('SCHEMA_NO_FIELD', `${t.id} has no field ${field}`, `one of: id, ${t.fields.filter(x => x.id !== 'id').map(x => x.id).join(', ')}`);
    const v = norm(get(field));
    const test = (op: string, want: Scalar | Scalar[]): boolean => {
      switch (op) {
        case 'eq': return Array.isArray(want) ? want.some(w => eq(v, w)) : eq(v, want);
        case 'in': return (Array.isArray(want) ? want : [want]).some(w => eq(v, w));
        case 'ne': return Array.isArray(want) ? !want.some(w => eq(v, w)) : !eq(v, want);
        case 'gt': return cmp(v, want as Scalar) > 0; case 'gte': return cmp(v, want as Scalar) >= 0;
        case 'lt': return cmp(v, want as Scalar) < 0; case 'lte': return cmp(v, want as Scalar) <= 0;
        case 'contains': return v !== null && String(v).toLowerCase().includes(String(want).toLowerCase());
        default: throw new RowsError('BAD_REQUEST', `unknown where operator ${op}`, 'eq, ne, gt, gte, lt, lte, contains, in');
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
export function readRows(f: FiniDB, t: Table, offset: number, limit: number, opts: { where?: Where; q?: string; sort?: string } = {}): { rows: Record<string, Value>[]; count: number } {
  let idx = Array.from({ length: t.rowCount }, (_, i) => i);
  if ((opts.where && Object.keys(opts.where).length) || opts.q) idx = idx.filter(i => rowMatches(f, t, i, opts.where ?? {}, opts.q));
  if (opts.sort) {
    const keys = opts.sort.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ field: s.replace(/^-/, ''), desc: s.startsWith('-') }));
    for (const k of keys) if (k.field !== 'id' && !t.hasField(k.field)) throw new RowsError('SCHEMA_NO_FIELD', `${t.id} has no field ${k.field}`);
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