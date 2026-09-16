/**
 * Tracing evaluator for `explain` (doc 08 §2, doc 10 §5): evaluates one cell's governing rule and
 * records the reads the rule makes directly (not the reads those reads make). Aggregates over
 * rows are recorded once as a set. Built on the reference evaluator so it never disturbs the
 * incremental engine's state.
 */
import { Database, Table, Pivot, Field, Measure } from '../schema/schema.js';
import { Value, isError } from '../store/column.js';
import { ReferenceEvaluator, Ctx, RowsRes } from './reference.js';
import { FUNCTIONS } from './functions.js';
import type { Rule } from '../schema/rules.js';

export interface Precedent {
  kind: 'cell' | 'field' | 'rows';
  table: string;
  measure?: string;
  at?: Record<string, string>;      // pivot coordinate as member ids
  row?: string;                     // tabular row id
  field?: string;
  rowsMatched?: number;             // for aggregates over rows
  text: string;                     // human label, e.g. "income_statement.value @ line=revenue, period=fy26"
  value: Value;
}

export class TracingEvaluator extends ReferenceEvaluator {
  precedents: Precedent[] = [];
  private recording = false;

  constructor(db: Database) { super(db); }

  /** Evaluate a rule at a context, recording its direct reads. */
  traceRule(rule: Rule, ctx: Ctx): Value {
    this.precedents = [];
    this.recording = true;
    try { return this.evalRule(rule, ctx); } finally { this.recording = false; }
  }

  cell(pivot: Pivot, measure: Measure, coord: Int32Array): Value {
    if (!this.recording) return super.cell(pivot, measure, coord);
    this.recording = false;
    try {
      const v = super.cell(pivot, measure, coord);
      const at: Record<string, string> = {};
      pivot.dims.forEach((d, i) => { at[d.id] = d.table.rowId(coord[i]); });
      this.precedents.push({ kind: 'cell', table: pivot.id, measure: measure.id, at, text: `${pivot.id}.${measure.id} @ ${Object.entries(at).map(([k, v]) => `${k}=${v}`).join(', ')}`, value: v });
      return v;
    } finally { this.recording = true; }
  }

  field(table: Table, field: Field, row: number): Value {
    if (!this.recording) return super.field(table, field, row);
    this.recording = false;
    try {
      const v = super.field(table, field, row);
      const shown = field.type === 'ref' && typeof v === 'number' ? field.refTable!.rowId(v) : v;
      this.precedents.push({ kind: 'field', table: table.id, field: field.id, row: table.rowId(row), text: `${table.id}.${field.id} @ ${table.rowId(row)}`, value: shown });
      return v;
    } finally { this.recording = true; }
  }

  protected aggregateRows(fn: string, res: RowsRes, ctx: Ctx): Value {
    if (!this.recording) return super.aggregateRows(fn, res, ctx);
    this.recording = false;
    try {
      const buckets = this.scanBuckets(res);
      const vals = buckets.get(this.ctxBucketKey(res)) ?? [];
      for (const v of vals) if (isError(v)) { this.precedents.push({ kind: 'rows', table: res.table.id, field: res.field.id, rowsMatched: vals.length, text: `${fn}(${res.key})`, value: v }); return v; }
      const v = FUNCTIONS[fn](vals);
      this.precedents.push({ kind: 'rows', table: res.table.id, field: res.field.id, rowsMatched: vals.length, text: `${fn}(${res.key}) over ${vals.length} rows`, value: v });
      return v;
    } finally { this.recording = true; }
  }
}
