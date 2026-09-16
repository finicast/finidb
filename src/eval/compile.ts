/**
 * Tier-2 compiler (doc 05 §9): turns a row-context rule whose references are all same-row fields
 * or paths through reference columns into a JS closure over typed arrays. Anything else returns
 * null and the interpreter is used. Semantics are kept identical by calling the same helpers
 * (num/eq/cmp/str/truthy) the interpreter uses; the differential test guards this.
 */
import type { Table, Field } from '../schema/schema.js';
import type { Rule } from '../schema/rules.js';
import type { Node } from '../lang/ast.js';
import { Value, isError, RefColumn } from '../store/column.js';
import { FUNCTIONS, num, str, eq, cmp, truthy, err } from './functions.js';
import type { Static, Ctx } from './reference.js';

export type RowFn = (r: number) => Value;

export interface CompileHost {
  classifyRef(node: Extract<Node, { k: 'ref' }>, ctx: Ctx): Static;
  field(table: Table, field: Field, row: number): Value;
  /** record a base-column dependency for the current compute pass */
  recordField(f: Field): void;
}

const NOT_COMPILABLE = new Set(['SUM', 'AVG', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTD', 'MIN', 'MAX', 'MEDIAN', 'FIRST', 'LAST', 'LISTAGG', 'PREV', 'NEXT', 'CUMSUM', 'TRAILING', 'PERIOD', 'RAND', 'RANDBETWEEN', 'TODAY']);

class Bail extends Error {}

export function compileRowRule(host: CompileHost, table: Table, rule: Rule): RowFn | null {
  if (!rule.ast) return null;
  try {
    const fn = compile(host, table, rule.ast);
    return fn;
  } catch (e) {
    if (e instanceof Bail) return null;
    return null;
  }
}

function compile(host: CompileHost, table: Table, n: Node): RowFn {
  switch (n.k) {
    case 'num': { const v = n.v; return () => v; }
    case 'str': { const v = n.v; return () => v; }
    case 'bool': { const v = n.v; return () => v; }
    case 'blank': return () => null;
    case 'un': {
      const e = compile(host, table, n.e);
      if (n.op === '-') return r => { const v = e(r); if (isError(v)) return v; const x = num(v); return isError(x) ? x : -x; };
      return r => { const v = e(r); return isError(v) ? v : !truthy(v); };
    }
    case 'bin': {
      const l = compile(host, table, n.l), rr = compile(host, table, n.r);
      switch (n.op) {
        case 'and': return r => { const a = l(r); if (isError(a)) return a; if (!truthy(a)) return false; const b = rr(r); return isError(b) ? b : truthy(b); };
        case 'or': return r => { const a = l(r); if (isError(a)) return a; if (truthy(a)) return true; const b = rr(r); return isError(b) ? b : truthy(b); };
        case '=': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; return eq(a, b); };
        case '!=': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; return !eq(a, b); };
        case '<': case '<=': case '>': case '>=': {
          const op = n.op;
          return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const c = cmp(a, b); if (isError(c)) return c; return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0; };
        }
        case '&': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = str(a), y = str(b); if (isError(x)) return x; if (isError(y)) return y; return x + y; };
        case '+': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = num(a), y = num(b); if (isError(x)) return x; if (isError(y)) return y; return x + y; };
        case '-': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = num(a), y = num(b); if (isError(x)) return x; if (isError(y)) return y; return x - y; };
        case '*': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = num(a), y = num(b); if (isError(x)) return x; if (isError(y)) return y; return x * y; };
        case '/': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = num(a), y = num(b); if (isError(x)) return x; if (isError(y)) return y; return y === 0 ? err('DIV0') : x / y; };
        case '^': return r => { const a = l(r); if (isError(a)) return a; const b = rr(r); if (isError(b)) return b; const x = num(a), y = num(b); if (isError(x)) return x; if (isError(y)) return y; return Math.pow(x, y); };
      }
      throw new Bail();
    }
    case 'call': {
      const name = n.name;
      if (NOT_COMPILABLE.has(name)) throw new Bail();
      const args = n.args.map(a => compile(host, table, a));
      if (name === 'IF') {
        const [c, t, f] = args;
        return r => { const v = c(r); if (isError(v)) return v; if (truthy(v)) return t ? t(r) : true; return f ? f(r) : 0; };
      }
      if (name === 'AND') return r => { for (const a of args) { const v = a(r); if (isError(v)) return v; if (!truthy(v)) return false; } return true; };
      if (name === 'OR') return r => { for (const a of args) { const v = a(r); if (isError(v)) return v; if (truthy(v)) return true; } return false; };
      if (name === 'IFERROR') return r => { const v = args[0](r); return isError(v) ? args[1](r) : v; };
      const fn = FUNCTIONS[name];
      if (!fn) throw new Bail();
      return r => { const vals: Value[] = new Array(args.length); for (let i = 0; i < args.length; i++) { const v = args[i](r); if (isError(v)) return v; vals[i] = v; } return fn(vals); };
    }
    case 'at': return compilePath(host, table, n.path);
    case 'ref': {
      if (n.selectors.length) throw new Bail();
      const st = host.classifyRef(n, { kind: 'row', table, row: 0 });
      if (st.k !== 'field') throw new Bail();
      return compileFieldPath(host, table, st.field, st.path);
    }
  }
}

function compilePath(host: CompileHost, table: Table, path: string[]): RowFn {
  if (path[0] === 'row') { if (path.length > 1) throw new Bail(); return r => r; }
  if (!table.hasField(path[0])) throw new Bail();
  return compileFieldPath(host, table, table.field(path[0]), path.slice(1));
}

/** Reader for `field.path…` starting at the current row. */
function compileFieldPath(host: CompileHost, table: Table, field: Field, path: string[]): RowFn {
  // resolve the hop chain statically
  const hops: { table: Table; field: Field }[] = [{ table, field }];
  let t: Table = table, f: Field = field;
  for (const name of path) {
    if (f.type !== 'ref') throw new Bail();
    t = f.refTable!;
    if (!t.hasField(name)) throw new Bail();
    f = t.field(name);
    hops.push({ table: t, field: f });
  }
  const last = hops[hops.length - 1];
  const readers = hops.map(h => makeReader(host, h.table, h.field));
  const finalIsRef = last.field.type === 'ref';
  const finalTable = last.field.refTable;
  if (hops.length === 1) {
    const rd = readers[0];
    if (finalIsRef) return r => { const v = rd(r); return typeof v === 'number' ? finalTable!.rowId(v) : v; };
    return rd;
  }
  return r => {
    let idx = r;
    for (let i = 0; i < readers.length - 1; i++) {
      const v = readers[i](idx);
      if (v === null) return null;
      if (isError(v)) return v;
      idx = v as number;
    }
    const v = readers[readers.length - 1](idx);
    if (finalIsRef) return typeof v === 'number' ? finalTable!.rowId(v) : v;
    return v;
  };
}

/** Direct typed-array reader for a base column; engine read for a computed one. */
function makeReader(host: CompileHost, table: Table, f: Field): RowFn {
  if (f.computed) return r => host.field(table, f, r);
  const col = f.column;
  if (col.type === 'ref') { const data = (col as RefColumn).data; return r => { host.recordField(f); const v = data[r]; return v < 0 ? null : v; }; }
  if (col.type === 'number') { const c = col as any; return r => { host.recordField(f); return c.nulls[r] ? null : c.data[r]; }; }
  return r => { host.recordField(f); return col.get(r); };
}
