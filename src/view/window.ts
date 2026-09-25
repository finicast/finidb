/**
 * The columnar window (doc 05 §10): what a client draws a grid or a chart from. It is built from the facade's
 * grid and nothing else, so the same code answers `POST /query` on the server and computes the window inside a
 * browser tab holding the same model.
 */
import type { FiniDB } from '../core.js';
import type { QueryOptions, Grid } from '../core.js';
import type { Pivot, Measure } from '../schema/schema.js';
import { isError, type Value } from '../store/column.js';

export class WindowError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
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
export function columnar(f: FiniDB, p: Pivot, q: QueryOptions): ColumnarWindow {
  for (const d of p.dims) if (!q.rows.includes(d.id) && !q.cols.includes(d.id) && q.pages?.[d.id] === undefined) throw new WindowError('QUERY_UNPINNED_DIM', `${d.id} must be on rows, cols or pages`);
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
