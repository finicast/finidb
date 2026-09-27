/**
 * How a number is written: the vocabulary a model uses to say that a line is money, a percentage, a count or
 * a date, and the one interpretation of it that the engine, a browser and a workbook all share.
 *
 * A format is either a name — `currency`, `percent`, `int`, `decimal`, `date`, `currency:EUR` — or a pattern
 * in the spreadsheet style people already know: `$#,##0.00`, `0.0%`, `#,##0`, `[$CHF]#,##0`. Names are
 * shorthands for patterns, so there is only ever one thing to interpret, and it maps onto a workbook's own
 * number formats without translation.
 *
 * It says nothing about colour, weight or when to show something: a format is how a number is written, not a
 * judgement about it.
 */
import { isError, type Value } from '../store/column.js';
import type { Pivot, Measure } from '../schema/schema.js';
import type { Clause } from '../schema/rules.js';

/** Whatever can tell whether a rule's conditions hold at a coordinate: both evaluators can. */
export interface ClauseTester { whenMatches(when: Clause[], ctx: { kind: 'pivot'; pivot: Pivot; coord: Int32Array }): boolean }

export interface FormatSpec {
  /** the number is a fraction written as a percentage */
  percent: boolean;
  /** what goes in front: a currency symbol, usually */
  prefix: string;
  /** what goes after: a unit, usually — the x of a multiple */
  suffix: string;
  /** how many decimal places; absent means "as many as the size of the number warrants" */
  decimals?: number;
  /** group the thousands */
  thousands: boolean;
  /** a day rather than a quantity */
  date: boolean;
}

const SYMBOLS: Record<string, string> = { usd: '$', eur: '€', gbp: '£', jpy: '¥', chf: 'CHF ', cad: 'CA$', aud: 'A$', inr: '₹', cny: '¥', brl: 'R$', mxn: 'MX$', sek: 'kr ', nok: 'kr ', dkk: 'kr ', zar: 'R' };

/** The named formats, as the patterns they stand for. */
const NAMES: Record<string, string> = {
  percent: '0.0%', pct: '0.0%', '%': '0.0%',
  currency: '$#,##0', money: '$#,##0', usd: '$#,##0', dollars: '$#,##0',
  multiple: '#,##0.0"x"', times: '#,##0.0"x"', x: '#,##0.0"x"',
  int: '#,##0', integer: '#,##0', count: '#,##0', number: '#,##0',
  decimal: '#,##0.00', dec: '#,##0.00',
  date: 'date', text: 'text', general: '',
};

/** Read a format, by name or by pattern. Undefined when there is nothing to read or nothing we understand. */
export function parseFormat(spec: string | null | undefined): FormatSpec | undefined {
  if (spec === null || spec === undefined) return undefined;
  const raw = String(spec).trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();

  // currency:EUR — a model that holds figures in something other than dollars
  const named = /^currency:([a-z]{3})$/.exec(lower);
  if (named) return { percent: false, prefix: SYMBOLS[named[1]] ?? `${named[1].toUpperCase()} `, suffix: '', decimals: 0, thousands: true, date: false };
  if (lower in SYMBOLS && lower !== 'usd') return { percent: false, prefix: SYMBOLS[lower], suffix: '', decimals: 0, thousands: true, date: false };

  const pattern = lower in NAMES ? NAMES[lower] : raw;
  if (pattern === 'date') return { percent: false, prefix: '', suffix: '', thousands: false, date: true };
  if (pattern === 'text' || pattern === '') return undefined;
  return parsePattern(pattern);
}

/** `[$CHF]#,##0.00`, `$#,##0`, `0.0%`, `#,##0` — the part of the spreadsheet vocabulary a model needs. */
function parsePattern(p: string): FormatSpec | undefined {
  let rest = p.trim();
  let prefix = '';
  const bracket = /^\[\$([^\]]{1,6})\]/.exec(rest);
  if (bracket) { prefix = SYMBOLS[bracket[1].toLowerCase()] ?? `${bracket[1]} `; rest = rest.slice(bracket[0].length); }
  else { const sym = /^([$€£¥₹]|CHF |R\$|CA\$|A\$|MX\$)/i.exec(rest); if (sym) { prefix = sym[1]; rest = rest.slice(sym[1].length); } }
  // a literal after the digits, quoted as a spreadsheet writes it: 0.0"x" for a multiple
  let suffix = '';
  const tail = /"([^"]{0,8})"$/.exec(rest);
  if (tail) { suffix = tail[1]; rest = rest.slice(0, -tail[0].length); }
  const percent = rest.endsWith('%');
  if (percent) rest = rest.slice(0, -1);
  if (!/^[#0,.]*$/.test(rest)) return undefined;                 // anything else is not a pattern we know
  if (!rest && !prefix && !percent && !suffix) return undefined;
  const dot = rest.indexOf('.');
  const decimals = dot < 0 ? (rest ? 0 : undefined) : rest.length - dot - 1;
  return { percent, prefix, suffix, decimals, thousands: rest.includes(','), date: false };
}

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Write a number as the format says. `parens` is the theme's convention for negatives, not the format's. */
export function formatNumber(v: number, spec?: FormatSpec, opts: { parens?: boolean } = {}): string {
  if (!Number.isFinite(v)) return '';
  const s = spec;
  const percent = s?.percent ?? false;
  const n = percent ? v * 100 : v;
  const abs = Math.abs(n);
  // A format that fixes the decimals means exactly that many. Without one, the size of the number decides how
  // many are worth showing and trailing zeros are dropped, so a count reads as 4 rather than 4.00.
  const loose = s?.decimals === undefined;
  const dp = s?.decimals ?? (abs >= 1000 ? 0 : abs >= 100 ? 1 : 2);
  // toFixed rounds the double, and the double behind 9.85 is 9.84999…, which rounds down to 9.8 where a
  // reader expects 9.9. A relative nudge rounds the number they typed rather than its remainder.
  let fixed = (abs + Number.EPSILON * abs).toFixed(dp);
  if (loose && fixed.includes('.')) fixed = fixed.replace(/\.?0+$/, '');
  const [int, frac] = fixed.split('.');
  const body = (s?.thousands === false ? int : group(int)) + (frac ? `.${frac}` : '');
  const text = `${s?.prefix ?? ''}${body}${percent ? '%' : ''}${s?.suffix ?? ''}`;
  if (n >= 0 || Object.is(n, -0)) return text;
  return opts.parens ? `(${text})` : `-${text}`;
}

/** Write any cell value: errors as #CODE, text as itself, numbers as the format says. */
export function formatValue(v: Value, spec?: string | null, opts: { parens?: boolean } = {}): string {
  if (v === null || v === undefined || v === '') return '';
  if (isError(v)) return `#${v.error}`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v !== 'number') return String(v);
  return formatNumber(v, parseFormat(spec), opts);
}

/** Is this format a percentage? Charts and deltas ask, because a percentage point is not a percentage. */
export function isPercent(spec: string | null | undefined): boolean {
  return parseFormat(spec)?.percent ?? false;
}

/** The spreadsheet pattern for a format, for a workbook that has to write one. */
export function toPattern(spec: string | null | undefined): string | undefined {
  const f = parseFormat(spec);
  if (!f) return undefined;
  if (f.date) return 'date';
  const digits = (f.thousands ? '#,##0' : '0') + (f.decimals ? `.${'0'.repeat(f.decimals)}` : '');
  return `${f.prefix}${digits}${f.percent ? '%' : ''}${f.suffix ? `"${f.suffix}"` : ''}`;
}

/**
 * The format of one cell, resolved once for everyone who draws it.
 *
 *   1. A format rule, last matching first, over the same selectors a value rule uses. This is where a model
 *      settles the awkward cases: a variance % column crossing a currency line.
 *   2. Otherwise what the cell's own members declare — a `format` attribute on any dimension, not only the
 *      one on rows. A percentage anywhere wins, because a percentage of money is a percentage; failing that
 *      the last dimension that says anything.
 *   3. Otherwise the measure's own format.
 */
export function formatOf(ev: ClauseTester, p: Pivot, m: Measure, coord: Int32Array): string | undefined {
  for (let i = p.rules.length - 1; i >= 0; i--) {
    const r = p.rules[i];
    if (r.kind !== 'format' || r.status !== 'ok' || r.target !== m.id) continue;
    if (ev.whenMatches(r.when, { kind: 'pivot', pivot: p, coord })) return r.formula;
  }
  let declared: string | undefined;
  for (let i = 0; i < p.dims.length; i++) {
    const d = p.dims[i];
    if (!d.table.hasField('format')) continue;
    const v = d.table.field('format').column.get(coord[i]);
    const spec = v === null || v === undefined ? '' : String(v);
    if (!spec) continue;
    if (isPercent(spec)) return spec;
    declared = spec;
  }
  return declared ?? m.format;
}

/** Does this pivot format any cell by rule? Windows skip the per-cell walk when nothing would come of it. */
export function hasFormatRules(p: Pivot): boolean {
  return p.rules.some(r => r.kind === 'format' && r.status === 'ok');
}
