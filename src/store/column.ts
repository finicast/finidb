/**
 * Typed, growable columns. A foreign-key ('ref') value IS the target row index,
 * so following a reference is an array read (doc 03 §3, doc 05 §2).
 */

export type FieldType = 'number' | 'text' | 'date' | 'bool' | 'ref';

/** JS-side scalar value. Dates are days since the Unix epoch (integer). */
export type Scalar = number | string | boolean | null;

export interface CellError { error: string; message?: string; fix?: string }
export type Value = Scalar | CellError;

export function isError(v: unknown): v is CellError {
  return typeof v === 'object' && v !== null && 'error' in (v as object);
}

const INITIAL = 1024;

export abstract class Column {
  abstract readonly type: FieldType;
  length = 0;
  version = 0;
  abstract get(i: number): Scalar;
  abstract set(i: number, v: Scalar): void;
  abstract ensure(n: number): void;
  /** Append a value; returns the row index. */
  push(v: Scalar): number {
    const i = this.length;
    this.ensure(i + 1);
    this.length = i + 1;
    this.set(i, v);
    return i;
  }
}

function grow<T extends Float64Array | Int32Array | Uint8Array>(arr: T, n: number, ctor: new (n: number) => T): T {
  if (arr.length >= n) return arr;
  let cap = Math.max(INITIAL, arr.length);
  while (cap < n) cap *= 2;
  const next = new ctor(cap);
  next.set(arr);
  return next;
}

export class NumberColumn extends Column {
  readonly type = 'number' as const;
  data = new Float64Array(INITIAL);
  nulls = new Uint8Array(INITIAL); // 1 = null
  ensure(n: number) { this.data = grow(this.data, n, Float64Array); this.nulls = grow(this.nulls, n, Uint8Array); }
  get(i: number): Scalar { return this.nulls[i] ? null : this.data[i]; }
  set(i: number, v: Scalar) {
    this.version++;
    if (v === null || v === undefined || v === '') { this.nulls[i] = 1; this.data[i] = 0; return; }
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isNaN(n)) { this.nulls[i] = 1; this.data[i] = 0; return; }
    this.nulls[i] = 0; this.data[i] = n;
  }
}

/** Dates stored as integer days since epoch. */
export class DateColumn extends Column {
  readonly type = 'date' as const;
  data = new Int32Array(INITIAL);
  nulls = new Uint8Array(INITIAL);
  ensure(n: number) { this.data = grow(this.data, n, Int32Array); this.nulls = grow(this.nulls, n, Uint8Array); }
  get(i: number): Scalar { return this.nulls[i] ? null : this.data[i]; }
  set(i: number, v: Scalar) {
    this.version++;
    const d = toDays(v);
    if (d === null) { this.nulls[i] = 1; this.data[i] = 0; } else { this.nulls[i] = 0; this.data[i] = d; }
  }
}

export function toDays(v: Scalar | Date): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 86400000);
  if (typeof v === 'number') return Math.floor(v);
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 86400000);
  }
  return null;
}

export function daysToISO(d: number): string {
  return new Date(d * 86400000).toISOString().slice(0, 10);
}

export class BoolColumn extends Column {
  readonly type = 'bool' as const;
  data = new Uint8Array(INITIAL); // 0 false, 1 true, 2 null
  ensure(n: number) { this.data = grow(this.data, n, Uint8Array); }
  get(i: number): Scalar { const b = this.data[i]; return b === 2 ? null : b === 1; }
  set(i: number, v: Scalar) {
    this.version++;
    if (v === null || v === undefined || v === '') { this.data[i] = 2; return; }
    this.data[i] = (v === true || v === 1 || v === 'true' || v === 'TRUE') ? 1 : 0;
  }
}

/** Dictionary-encoded text. */
export class TextColumn extends Column {
  readonly type = 'text' as const;
  codes = new Int32Array(INITIAL).fill(-1); // -1 = null
  dict: string[] = [];
  index = new Map<string, number>();
  ensure(n: number) { const old = this.codes.length; this.codes = grow(this.codes, n, Int32Array); if (this.codes.length > old) this.codes.fill(-1, old); }
  code(s: string): number {
    let c = this.index.get(s);
    if (c === undefined) { c = this.dict.length; this.dict.push(s); this.index.set(s, c); }
    return c;
  }
  get(i: number): Scalar { const c = this.codes[i]; return c < 0 ? null : this.dict[c]; }
  set(i: number, v: Scalar) {
    this.version++;
    if (v === null || v === undefined) { this.codes[i] = -1; return; }
    this.codes[i] = this.code(typeof v === 'string' ? v : String(v));
  }
}

/** Foreign key: the value is the target table's row index (-1 = null). */
export class RefColumn extends Column {
  readonly type = 'ref' as const;
  data = new Int32Array(INITIAL);
  constructor(public readonly targetTableId: number) { super(); this.data.fill(-1); }
  ensure(n: number) { const old = this.data.length; this.data = grow(this.data, n, Int32Array); if (this.data.length > old) this.data.fill(-1, old); }
  get(i: number): Scalar { const r = this.data[i]; return r < 0 ? null : r; }
  set(i: number, v: Scalar) { this.version++; this.data[i] = (v === null || v === undefined || v === '') ? -1 : (v as number); }
}

export function makeColumn(type: FieldType, refTarget?: number): Column {
  switch (type) {
    case 'number': return new NumberColumn();
    case 'text': return new TextColumn();
    case 'date': return new DateColumn();
    case 'bool': return new BoolColumn();
    case 'ref': if (refTarget === undefined) throw new Error('ref column needs a target'); return new RefColumn(refTarget);
  }
}
