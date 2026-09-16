/** Scalar function library (doc 04 §6). Aggregates over sets are handled by the evaluator. */
import { Value, CellError, isError, daysToISO, toDays } from '../store/column.js';

export const err = (code: string, message?: string): CellError => ({ error: code, message });

export function num(v: Value): number | CellError {
  if (isError(v)) return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? err('TYPE', `"${v}" is not a number`) : n;
}
export function str(v: Value): string | CellError {
  if (isError(v)) return v;
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}
export function bool(v: Value): boolean | CellError {
  if (isError(v)) return v;
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.toLowerCase() === 'true';
}
export function truthy(v: Value): boolean { const b = bool(v); return isError(b) ? false : b; }

export function eq(a: Value, b: Value): boolean {
  if (a === null || a === undefined || a === '') a = null;
  if (b === null || b === undefined || b === '') b = null;
  if (a === null && b === null) return true;
  if (a === null) return b === 0 || b === false; // blank == 0 (Excel-like)
  if (b === null) return a === 0 || a === false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === 'number' && typeof b === 'string') { const n = Number(b); return !Number.isNaN(n) && eq(a, n); }
  if (typeof b === 'number' && typeof a === 'string') return eq(b, a);
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
export function cmp(a: Value, b: Value): number | CellError {
  if (isError(a)) return a; if (isError(b)) return b;
  if (typeof a === 'string' && typeof b === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  const x = num(a), y = num(b);
  if (isError(x)) return x; if (isError(y)) return y;
  return x < y ? -1 : x > y ? 1 : 0;
}

type Fn = (args: Value[]) => Value;

function nums(args: Value[]): number[] | CellError {
  const out: number[] = [];
  for (const a of args) { if (a === null || a === '') continue; const n = num(a); if (isError(n)) return n; out.push(n); }
  return out;
}
function n1(f: (x: number) => number): Fn { return a => { const x = num(a[0]); return isError(x) ? x : f(x); }; }
function n2(f: (x: number, y: number) => number): Fn { return a => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; return f(x, y); }; }
function roundTo(x: number, d: number, mode: 'round' | 'up' | 'down'): number {
  const m = Math.pow(10, d);
  const v = x * m;
  const r = mode === 'round' ? Math.round(Math.abs(v)) * Math.sign(v) : mode === 'up' ? Math.ceil(Math.abs(v)) * Math.sign(v) : Math.trunc(v);
  return r / m;
}

// ---- dates ----
function dparts(d: number) { const dt = new Date(d * 86400000); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() }; }
function mkdate(y: number, m: number, d: number): number { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
function dateArg(v: Value): number | CellError { if (isError(v)) return v; const d = toDays(v); return d === null ? err('TYPE', 'not a date') : d; }

// ---- finance ----
function pmt(rate: number, nper: number, pv: number, fv = 0, type = 0): number {
  if (rate === 0) return -(pv + fv) / nper;
  const r1 = Math.pow(1 + rate, nper);
  return -(rate * (pv * r1 + fv)) / ((1 + rate * type) * (r1 - 1));
}
function npv(rate: number, values: number[]): number { return values.reduce((s, v, i) => s + v / Math.pow(1 + rate, i + 1), 0); }
function irr(values: number[], guess = 0.1): number | CellError {
  let r = guess;
  for (let it = 0; it < 100; it++) {
    let f = 0, df = 0;
    for (let i = 0; i < values.length; i++) { const d = Math.pow(1 + r, i); f += values[i] / d; df -= i * values[i] / (d * (1 + r)); }
    if (Math.abs(f) < 1e-10) return r;
    if (df === 0) break;
    const nr = r - f / df;
    if (!Number.isFinite(nr)) break;
    if (Math.abs(nr - r) < 1e-12) return nr;
    r = nr;
  }
  return err('NUM', 'IRR did not converge');
}

export const FUNCTIONS: Record<string, Fn> = {
  // logic (IF/AND/OR/IFERROR are special forms in the evaluator; these are eager fallbacks)
  NOT: a => { const b = bool(a[0]); return isError(b) ? b : !b; },
  ISBLANK: a => a[0] === null || a[0] === undefined || a[0] === '',
  ISNUMBER: a => typeof a[0] === 'number',
  ISTEXT: a => typeof a[0] === 'string',
  ISLOGICAL: a => typeof a[0] === 'boolean',
  ISERROR: a => isError(a[0]),
  COALESCE: a => { for (const v of a) if (!(v === null || v === undefined || v === '')) return v; return null; },
  // math
  ABS: n1(Math.abs), SQRT: n1(x => x < 0 ? NaN : Math.sqrt(x)), EXP: n1(Math.exp), LN: n1(Math.log), LOG10: n1(Math.log10), SIGN: n1(Math.sign),
  LOG: a => { const x = num(a[0]); if (isError(x)) return x; const b = a.length > 1 ? num(a[1]) : 10; if (isError(b)) return b; return Math.log(x) / Math.log(b); },
  POWER: n2(Math.pow), MOD: n2((x, y) => y === 0 ? NaN : x - y * Math.floor(x / y)),
  ROUND: a => { const x = num(a[0]); if (isError(x)) return x; const d = a.length > 1 ? num(a[1]) : 0; if (isError(d)) return d; return roundTo(x, d, 'round'); },
  ROUNDUP: a => { const x = num(a[0]); if (isError(x)) return x; const d = a.length > 1 ? num(a[1]) : 0; if (isError(d)) return d; return roundTo(x, d, 'up'); },
  ROUNDDOWN: a => { const x = num(a[0]); if (isError(x)) return x; const d = a.length > 1 ? num(a[1]) : 0; if (isError(d)) return d; return roundTo(x, d, 'down'); },
  TRUNC: a => { const x = num(a[0]); if (isError(x)) return x; const d = a.length > 1 ? num(a[1]) : 0; if (isError(d)) return d; return roundTo(x, d, 'down'); },
  MROUND: n2((x, m) => m === 0 ? 0 : Math.round(x / m) * m),
  RAND: () => Math.random(),
  RANDBETWEEN: n2((lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1))),
  DIVIDE: a => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; return y === 0 ? err('DIV0') : x / y; },
  // scalar forms of aggregates (sets are expanded by the evaluator before reaching here)
  SUM: a => { const v = nums(a); return isError(v) ? v : v.reduce((s, x) => s + x, 0); },
  AVG: a => { const v = nums(a); if (isError(v)) return v; return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; },
  AVERAGE: a => FUNCTIONS.AVG(a),
  COUNT: a => { let c = 0; for (const v of a) if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)))) c++; return c; },
  COUNTA: a => a.filter(v => !(v === null || v === undefined || v === '')).length,
  COUNTBLANK: a => a.filter(v => v === null || v === undefined || v === '').length,
  COUNTD: a => new Set(a.filter(v => !(v === null || v === undefined || v === '')).map(v => String(v).toLowerCase())).size,
  MIN: a => { const v = nums(a); if (isError(v)) return v; return v.length ? Math.min(...v) : null; },
  MAX: a => { const v = nums(a); if (isError(v)) return v; return v.length ? Math.max(...v) : null; },
  MEDIAN: a => { const v = nums(a); if (isError(v)) return v; if (!v.length) return null; v.sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
  FIRST: a => { for (const v of a) if (!(v === null || v === undefined || v === '')) return v; return null; },
  LAST: a => { for (let i = a.length - 1; i >= 0; i--) { const v = a[i]; if (!(v === null || v === undefined || v === '')) return v; } return null; },
  LISTAGG: a => { const sep = typeof a[a.length - 1] === 'string' && a.length > 1 && (a[a.length - 1] as string).length <= 3 ? (a.pop() as string) : ', '; return a.filter(v => !(v === null || v === '')).map(v => String(v)).join(sep); },
  // text
  CONCAT: a => { let s = ''; for (const v of a) { const t = str(v); if (isError(t)) return t; s += t; } return s; },
  LEFT: a => { const s = str(a[0]); if (isError(s)) return s; const n = a.length > 1 ? num(a[1]) : 1; if (isError(n)) return n; return s.slice(0, n); },
  RIGHT: a => { const s = str(a[0]); if (isError(s)) return s; const n = a.length > 1 ? num(a[1]) : 1; if (isError(n)) return n; return n === 0 ? '' : s.slice(-n); },
  MID: a => { const s = str(a[0]); if (isError(s)) return s; const st = num(a[1]), n = num(a[2]); if (isError(st)) return st; if (isError(n)) return n; return s.substr(st - 1, n); },
  LEN: a => { const s = str(a[0]); return isError(s) ? s : s.length; },
  LOWER: a => { const s = str(a[0]); return isError(s) ? s : s.toLowerCase(); },
  UPPER: a => { const s = str(a[0]); return isError(s) ? s : s.toUpperCase(); },
  TRIM: a => { const s = str(a[0]); return isError(s) ? s : s.trim().replace(/\s+/g, ' '); },
  REPLACE: a => { const s = str(a[0]); if (isError(s)) return s; const st = num(a[1]), n = num(a[2]), r = str(a[3]); if (isError(st)) return st; if (isError(n)) return n; if (isError(r)) return r; return s.slice(0, st - 1) + r + s.slice(st - 1 + n); },
  SUBSTITUTE: a => { const s = str(a[0]), o = str(a[1]), r = str(a[2]); if (isError(s)) return s; if (isError(o)) return o; if (isError(r)) return r; return o === '' ? s : s.split(o).join(r); },
  CONTAINS: a => { const s = str(a[0]), t = str(a[1]); if (isError(s)) return s; if (isError(t)) return t; return s.toLowerCase().includes(t.toLowerCase()); },
  STARTSWITH: a => { const s = str(a[0]), t = str(a[1]); if (isError(s)) return s; if (isError(t)) return t; return s.toLowerCase().startsWith(t.toLowerCase()); },
  ENDSWITH: a => { const s = str(a[0]), t = str(a[1]); if (isError(s)) return s; if (isError(t)) return t; return s.toLowerCase().endsWith(t.toLowerCase()); },
  EXACT: a => { const s = str(a[0]), t = str(a[1]); if (isError(s)) return s; if (isError(t)) return t; return s === t; },
  TEXT: a => { const v = a[0]; if (isError(v)) return v; if (typeof v === 'number' && typeof a[1] === 'string' && /^0\.0+$/.test(a[1])) return v.toFixed(a[1].length - 2); return str(v); },
  STRING: a => str(a[0]),
  VALUE: a => num(a[0]),
  // dates
  DATE: a => { const y = num(a[0]), m = num(a[1]), d = num(a[2]); if (isError(y)) return y; if (isError(m)) return m; if (isError(d)) return d; return mkdate(y, m, d); },
  TODAY: () => Math.floor(Date.now() / 86400000),
  YEAR: a => { const d = dateArg(a[0]); return isError(d) ? d : dparts(d).y; },
  MONTH: a => { const d = dateArg(a[0]); return isError(d) ? d : dparts(d).m; },
  DAY: a => { const d = dateArg(a[0]); return isError(d) ? d : dparts(d).d; },
  QUARTER: a => { const d = dateArg(a[0]); return isError(d) ? d : Math.ceil(dparts(d).m / 3); },
  WEEKDAY: a => { const d = dateArg(a[0]); return isError(d) ? d : dparts(d).wd + 1; },
  DAYS: a => { const x = dateArg(a[0]), y = dateArg(a[1]); if (isError(x)) return x; if (isError(y)) return y; return x - y; },
  EOMONTH: a => { const d = dateArg(a[0]); if (isError(d)) return d; const k = a.length > 1 ? num(a[1]) : 0; if (isError(k)) return k; const p = dparts(d); return mkdate(p.y, p.m + k + 1, 0); },
  SOMONTH: a => { const d = dateArg(a[0]); if (isError(d)) return d; const k = a.length > 1 ? num(a[1]) : 0; if (isError(k)) return k; const p = dparts(d); return mkdate(p.y, p.m + k, 1); },
  DATEOP: a => { const d = dateArg(a[0]); if (isError(d)) return d; const n = num(a[1]); if (isError(n)) return n; const unit = String(a[2] ?? 'day').toLowerCase(); const p = dparts(d); if (unit.startsWith('y')) return mkdate(p.y + n, p.m, p.d); if (unit.startsWith('m')) return mkdate(p.y, p.m + n, p.d); return d + n; },
  DATEDIF: a => { const x = dateArg(a[0]), y = dateArg(a[1]); if (isError(x)) return x; if (isError(y)) return y; const unit = String(a[2] ?? 'd').toLowerCase(); const p = dparts(x), q = dparts(y); if (unit === 'y') return q.y - p.y - ((q.m < p.m || (q.m === p.m && q.d < p.d)) ? 1 : 0); if (unit === 'm') return (q.y - p.y) * 12 + (q.m - p.m) - (q.d < p.d ? 1 : 0); return y - x; },
  YEARFRAC: a => { const x = dateArg(a[0]), y = dateArg(a[1]); if (isError(x)) return x; if (isError(y)) return y; return (y - x) / 365; },
  DATEISO: a => { const d = dateArg(a[0]); return isError(d) ? d : daysToISO(d); },
  // finance
  PMT: a => { const v = nums(a); if (isError(v)) return v; return pmt(v[0], v[1], v[2], v[3] ?? 0, v[4] ?? 0); },
  PV: a => { const v = nums(a); if (isError(v)) return v; const [rate, nper, p, fv = 0, type = 0] = v; if (rate === 0) return -(p * nper + fv); const r1 = Math.pow(1 + rate, nper); return -(p * (1 + rate * type) * (r1 - 1) / rate + fv) / r1; },
  FV: a => { const v = nums(a); if (isError(v)) return v; const [rate, nper, p, pv = 0, type = 0] = v; if (rate === 0) return -(pv + p * nper); const r1 = Math.pow(1 + rate, nper); return -(pv * r1 + p * (1 + rate * type) * (r1 - 1) / rate); },
  NPV: a => { const v = nums(a); if (isError(v)) return v; return npv(v[0], v.slice(1)); },
  IRR: a => { const v = nums(a); if (isError(v)) return v; return irr(v); },
  NPER: a => { const v = nums(a); if (isError(v)) return v; const [rate, p, pv, fv = 0, type = 0] = v; if (rate === 0) return -(pv + fv) / p; return Math.log((p * (1 + rate * type) - fv * rate) / (p * (1 + rate * type) + pv * rate)) / Math.log(1 + rate); },
  SLN: a => { const v = nums(a); if (isError(v)) return v; return (v[0] - v[1]) / v[2]; },
  SYD: a => { const v = nums(a); if (isError(v)) return v; const [c, s, l, p] = v; return (c - s) * (l - p + 1) * 2 / (l * (l + 1)); },
  DDB: a => { const v = nums(a); if (isError(v)) return v; const [c, s, l, p, f = 2] = v; let bv = c, dep = 0; for (let i = 1; i <= p; i++) { dep = Math.min(bv * f / l, bv - s); bv -= dep; } return dep; },
  GROWTH: a => { const v = nums(a); if (isError(v)) return v; return v[0] * Math.pow(1 + v[1], v[2]); },
  IPMT: a => { const v = nums(a); if (isError(v)) return v; const [rate, per, nper, pv, fv = 0, type = 0] = v; const p = pmt(rate, nper, pv, fv, type); let bal = pv; for (let i = 1; i < per; i++) { const int = bal * rate; bal += (type ? 0 : int) + p; } return -(bal * rate); },
  PPMT: a => { const v = nums(a); if (isError(v)) return v; const [rate, per, nper, pv, fv = 0, type = 0] = v; const p = pmt(rate, nper, pv, fv, type); const ip = FUNCTIONS.IPMT([rate, per, nper, pv, fv, type]) as number; return p - ip; },
  RATE: a => { const v = nums(a); if (isError(v)) return v; const [nper, p, pv, fv = 0, type = 0] = v; let r = 0.1; for (let i = 0; i < 100; i++) { const f = pv * Math.pow(1 + r, nper) + p * (1 + r * type) * (Math.pow(1 + r, nper) - 1) / r + fv; const h = 1e-6; const f2 = pv * Math.pow(1 + r + h, nper) + p * (1 + (r + h) * type) * (Math.pow(1 + r + h, nper) - 1) / (r + h) + fv; const d = (f2 - f) / h; if (d === 0) break; const nr = r - f / d; if (Math.abs(nr - r) < 1e-10) return nr; r = nr; } return r; },
};
