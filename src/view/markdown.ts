import { Value, isError } from '../store/column.js';

/** Fast number formatting with thousands separators (toLocaleString is ~50x slower). */
export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return String(v);
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const intPart = dot < 0 ? fixed : fixed.slice(0, dot);
  const frac = dot < 0 ? '' : fixed.slice(dot);
  let out = '';
  for (let i = 0; i < intPart.length; i++) { if (i > 0 && (intPart.length - i) % 3 === 0) out += ','; out += intPart[i]; }
  return (neg ? '-' : '') + out + (decimals > 0 ? frac.replace(/\.?0+$/, '') : '');
}

export function formatValue(v: Value, format?: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (isError(v)) return `#${v.error}`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (format === 'percent' || format === '%') return (v * 100).toFixed(1) + '%';
  if (format === 'int' || Number.isInteger(v) || Math.abs(v) >= 1000) return formatNumber(v, 0);
  return formatNumber(v, 2);
}

export interface Grid {
  title?: string;
  rowHeaders: string[][];   // one entry per row; each may have several header columns
  rowHeaderNames: string[];
  colHeaders: string[];
  values: Value[][];        // rows × cols
  formats?: (string | undefined)[][];
  /** member id tuples behind each row / column header (same order as rowHeaders / colHeaders) */
  rowIds?: string[][];
  colIds?: string[][];
  /** per cell: 0 blank · 1 computed · 2 input · 3 error */
  state?: number[][];
}

export function renderMarkdown(g: Grid): string {
  const nh = g.rowHeaderNames.length;
  const cells: string[][] = g.values.map((row, r) => [...g.rowHeaders[r], ...row.map((v, c) => formatValue(v, g.formats?.[r]?.[c]))]);
  const header = [...g.rowHeaderNames, ...g.colHeaders];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map(row => row[i].length)));
  const line = (row: string[]) => '| ' + row.map((s, i) => i < nh ? s.padEnd(widths[i]) : s.padStart(widths[i])).join(' | ') + ' |';
  const out: string[] = [];
  if (g.title) out.push(`## ${g.title}`, '');
  out.push(line(header));
  out.push('|' + widths.map((w, i) => i < nh ? '-'.repeat(w + 2) : '-'.repeat(w + 1) + ':').join('|') + '|');
  for (const row of cells) out.push(line(row));
  return out.join('\n');
}
