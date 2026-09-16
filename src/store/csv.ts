/** CSV parsing with type inference and foreign-key candidate detection (doc 08 §2 finicast_load_table). */
import { FieldType, Scalar, toDays } from './column.js';

export interface InferredField { id: string; name: string; type: FieldType; distinct: number; sample: Scalar[]; nullCount: number }
export interface ParsedCsv { header: string[]; rows: string[][] }

export function parseCsv(text: string, delimiter = ','): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(x => x.trim() !== ''));
  const header = (nonEmpty.shift() ?? []).map(h => h.trim());
  return { header, rows: nonEmpty };
}

export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(s) ? s : `f_${s}`;
}

const NUM = /^-?\$?\s*[\d,]*\.?\d+(e[+-]?\d+)?%?$/i;
const DATE = /^\d{4}-\d{1,2}-\d{1,2}(T.*)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

export function inferType(values: string[]): FieldType {
  let n = 0, d = 0, b = 0, total = 0;
  for (const v of values) {
    const s = v.trim();
    if (s === '') continue;
    total++;
    if (NUM.test(s)) n++;
    else if (DATE.test(s) && toDays(s) !== null) d++;
    else if (/^(true|false|yes|no)$/i.test(s)) b++;
  }
  if (total === 0) return 'text';
  if (n === total) return 'number';
  if (d === total) return 'date';
  if (b === total) return 'bool';
  return 'text';
}

export function coerce(v: string, type: FieldType): Scalar {
  const s = v.trim();
  if (s === '') return null;
  switch (type) {
    case 'number': { const pct = s.endsWith('%'); const n = Number(s.replace(/[$,%\s]/g, '')); return Number.isNaN(n) ? null : (pct ? n / 100 : n); }
    case 'date': return toDays(s);
    case 'bool': return /^(true|yes)$/i.test(s);
    default: return s;
  }
}

export interface LoadPlan {
  fields: { id: string; name: string; type: FieldType; ref?: string }[];
  idColumn?: string;
  rows: Record<string, Scalar>[];
  profile: InferredField[];
  warnings: string[];
}

/**
 * Turn parsed CSV into a load plan: slugged ids, inferred types, an id column (existing unique column or generated),
 * and ref candidates against the provided dimension tables (columns whose distinct values all appear in a table's ids).
 */
export function planLoad(csv: ParsedCsv, opts: { idColumn?: string; types?: Record<string, FieldType>; refs?: Record<string, string>; candidates?: Record<string, Set<string>> } = {}): LoadPlan {
  const warnings: string[] = [];
  const cols = csv.header.map((h, i) => ({ name: h, id: slug(h) || `col${i}`, values: csv.rows.map(r => r[i] ?? '') }));
  // de-duplicate ids
  const seen = new Map<string, number>();
  for (const c of cols) { const k = seen.get(c.id) ?? 0; seen.set(c.id, k + 1); if (k) c.id = `${c.id}_${k + 1}`; }
  const profile: InferredField[] = cols.map(c => {
    const type = opts.types?.[c.id] ?? inferType(c.values);
    const distinct = new Set(c.values.map(v => v.trim().toLowerCase())).size;
    return { id: c.id, name: c.name, type, distinct, sample: c.values.slice(0, 3).map(v => coerce(v, type)), nullCount: c.values.filter(v => v.trim() === '').length };
  });
  let idColumn = opts.idColumn;
  if (!idColumn) {
    const cand = profile.find(p => p.id === 'id' && p.distinct === csv.rows.length && p.nullCount === 0) ?? profile.find(p => p.type === 'text' && p.distinct === csv.rows.length && p.nullCount === 0 && /id$|^key$|^code$/i.test(p.id));
    if (cand) idColumn = cand.id; else warnings.push('no unique id column found; sequential ids generated');
  }
  const fields = profile.filter(p => p.id !== idColumn).map(p => {
    let ref = opts.refs?.[p.id];
    if (!ref && opts.candidates && p.type === 'text') {
      const col = cols.find(c => c.id === p.id)!;
      const vals = new Set(col.values.map(v => v.trim()).filter(v => v !== ''));
      for (const [table, ids] of Object.entries(opts.candidates)) {
        if (vals.size && [...vals].every(v => ids.has(v))) { ref = table; break; }
      }
    }
    return { id: p.id, name: p.name, type: ref ? ('ref' as FieldType) : p.type, ref };
  });
  const rows = csv.rows.map((r, i) => {
    const o: Record<string, Scalar> = {};
    cols.forEach((c, j) => {
      const p = profile[j];
      if (c.id === idColumn) o.id = r[j].trim();
      else { const f = fields.find(f => f.id === c.id)!; o[c.id] = f.type === 'ref' ? (r[j].trim() || null) : coerce(r[j] ?? '', p.type); }
    });
    if (!idColumn) o.id = String(i + 1);
    return o;
  });
  return { fields, idColumn, rows, profile, warnings };
}
