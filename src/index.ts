/**
 * FiniDB public facade (embedded mode).
 */
import { IterateSettings, Database, Model, Table, Pivot, Field, Dim, Measure, AnyTable } from './schema/schema.js';
import type { Rule, Clause } from './schema/rules.js';
import { parseRule, parseRules, ParseError } from './lang/parser.js';
import type { Selector, ParsedRule } from './lang/ast.js';
import { ReferenceEvaluator, EvalCore, CompileError } from './eval/reference.js';
import { IncrementalEngine } from './eval/incremental.js';
import { TracingEvaluator, Precedent } from './eval/trace.js';
import { Value, Scalar, FieldType, isError, toDays } from './store/column.js';
import { renderMarkdown, Grid } from './view/markdown.js';

export { Database, Model, Table, Pivot, Field, Dim, Measure, ReferenceEvaluator, IncrementalEngine, EvalCore, CompileError, ParseError, renderMarkdown, isError };
export type { Rule, Clause, Value, Scalar, FieldType, Grid, Precedent };
export { TracingEvaluator };

export interface FieldSpec { id: string; name?: string; type?: FieldType; ref?: string; computed?: boolean; format?: string }
export interface PeriodsSpec { start: string; count: number; grain: 'month' | 'quarter' | 'year'; histUntil?: string; idFormat?: 'short' | 'iso' }

export interface ExplainResult {
  table: string; measure: string; at: Record<string, string>;
  value: Value; source: 'input' | 'rule' | 'blank' | 'stored'; input?: Scalar;
  rule?: { text: string; order: number; formula: string };
  precedents: Precedent[];
  otherRules: { text: string; order: number; status: string; matches: boolean }[];
  referencedBy: string[];
  /** tabular explain: every field of the row */
  row?: Record<string, Value>;
  error?: { error: string; message?: string };
}

export interface QueryOptions {
  table: string;
  rows: string[];                       // dim ids
  cols: string[];
  pages?: Record<string, string>;       // dim -> member
  measure?: string;
  /** per dim: a member list, or an attribute test { attr, in } / { attr, eq } */
  filters?: Record<string, string[] | { attr: string; in?: (string | number | boolean)[]; eq?: string | number | boolean }>;
  /** sort rows by the values under one column (member ids joined by '/'), or by 'header' */
  sort?: { by: string; dir?: 'asc' | 'desc'; top?: number };
  title?: string;
  format?: 'markdown' | 'grid';
  formats?: Record<string, string>;     // member id (row) -> format
}

export interface FiniDBOptions { engine?: 'incremental' | 'reference' }

/** Render a rule in the line-item-first form when the pivot has a line dimension. */
export function formatRule(t: AnyTable, r: Rule): string {
  const clause = (c: Clause) => c.op === 'in' || c.op === 'not in' ? `${c.left} ${c.op} (${(c.right as unknown[]).join(', ')})` : `${c.left}${c.op}${String(c.right)}`;
  let target = r.target;
  let when = r.when;
  if (t.kind === 'pivot' && t.lineDim && when.length && when[0].left === t.lineDim.id && when[0].op === '=' && r.target === t.defaultMeasure.id) {
    target = String(when[0].right);
    when = when.slice(1);
  }
  return `${target}${when.length ? '[' + when.map(clause).join(', ') + ']' : ''} = ${r.formula}`;
}

export class FiniDB {
  readonly db = new Database();
  readonly evaluator: EvalCore;
  constructor(opts: FiniDBOptions = {}) {
    this.evaluator = opts.engine === 'reference' ? new ReferenceEvaluator(this.db) : new IncrementalEngine(this.db);
  }

  createModel(id: string, name?: string): Model { return this.db.createModel(id, name); }
  /** Export a model as an .xlsx workbook with live formulas compiled from its rules (doc 08). */
  exportXlsx(modelId: string, opts: ExportOptions = {}): ExportResult { return exportWorkbook(this.db, modelId, opts); }
  /** Turn iterative calculation on (`true` or `{ maxIterations, tolerance }`) or off for a model's same-period circularities. */
  setIterate(modelId: string, iterate: boolean | Partial<IterateSettings> | null | undefined): IterateSettings | undefined { const m = this.model(modelId); m.setIterate(iterate); return m.iterate; }
  model(id: string): Model { return this.db.model(id); }

  createTable(modelId: string, id: string, fields: FieldSpec[], opts: { name?: string; rows?: Record<string, Scalar>[] } = {}): Table {
    const m = this.model(modelId);
    const t = m.createTable(id, opts.name);
    for (const f of fields) this.addField(t, f);
    if (opts.rows) this.insertRows(t, opts.rows);
    return t;
  }
  addField(t: Table, f: FieldSpec): Field {
    if (f.id === 'id') return t.idField;
    const type: FieldType = f.ref ? 'ref' : (f.type ?? 'text');
    const refTable = f.ref ? (t.model.table(f.ref) as Table) : undefined;
    if (f.ref && refTable?.kind !== 'tabular') throw new Error(`SCHEMA_REF_NOT_TABULAR: ${f.ref}`);
    const field = t.addField(f.id, f.name ?? f.id, type, refTable);
    field.computed = !!f.computed;
    field.format = f.format;
    this.db.touch();
    return field;
  }
  /** Add a field to an existing table by ids (a computed field gets its rule via setRules). */
  addFieldTo(modelId: string, tableId: string, f: FieldSpec): Field {
    const t = this.model(modelId).table(tableId);
    if (t.kind !== 'tabular') throw new Error('SCHEMA_NOT_TABULAR: use addDim/addMeasure for pivots');
    return this.addField(t, f);
  }
  dropTable(modelId: string, tableId: string) {
    const m = this.model(modelId);
    const t = m.table(tableId);
    for (const other of m.tables.values()) {
      if (other === t) continue;
      if (other.kind === 'tabular' && other.fields.some(f => f.refTable === t)) throw new Error(`SCHEMA_IN_USE: ${other.id} references ${t.id}`);
      if (other.kind === 'pivot' && other.dims.some(d => d.table === t)) throw new Error(`SCHEMA_IN_USE: ${other.id} has a dimension over ${t.id}`);
    }
    m.tables.delete(t.id);
    this.db.schemaVersion++;
    this.db.touch();
  }
  deleteRows(modelId: string, tableId: string, ids: string[]): number {
    const t = this.model(modelId).table(tableId);
    if (t.kind !== 'tabular') throw new Error('SCHEMA_NOT_TABULAR');
    return t.deleteRows(ids);
  }
  dropField(modelId: string, tableId: string, fieldId: string) {
    const t = this.model(modelId).table(tableId);
    if (t.kind !== 'tabular') throw new Error('SCHEMA_NOT_TABULAR');
    for (const other of t.model.tables.values()) if (other.kind === 'pivot' && other.dims.some(d => d.table === t) && fieldId !== 'id') { /* attributes may be dropped; rules referencing them will error */ }
    t.dropField(fieldId);
  }
  dropModel(modelId: string) {
    this.model(modelId);
    this.db.models.delete(modelId);
    this.db.schemaVersion++;
    this.db.touch();
  }
  insertRows(t: Table, rows: Record<string, Scalar>[]): number {
    for (const r of rows) t.insertRow(r);
    this.db.touch();
    return t.rowCount;
  }

  /** Create a dimension table from the distinct values of another table's column. */
  createDistinctTable(modelId: string, id: string, sourceTable: string, sourceField: string): Table {
    const m = this.model(modelId);
    const src = m.table(sourceTable) as Table;
    const f = src.field(sourceField);
    const t = m.createTable(id);
    const seen = new Set<string>();
    for (let i = 0; i < src.rowCount; i++) {
      const v = f.column.get(i);
      if (v === null) continue;
      const s = f.type === 'ref' ? f.refTable!.rowId(v as number) : String(v);
      if (!seen.has(s)) { seen.add(s); t.insertRow({ id: s }); }
    }
    t.distinctOf = { table: src, field: f };
    this.db.touch();
    return t;
  }

  /** Generate a periods table with frame / quarter / year / start attributes. */
  createPeriods(modelId: string, id: string, spec: PeriodsSpec): Table {
    const m = this.model(modelId);
    const t = m.createTable(id, 'Periods');
    t.addField('name', 'Name', 'text');
    t.addField('start', 'Start', 'date');
    t.addField('end', 'End', 'date');
    t.addField('frame', 'Frame', 'text');
    t.addField('year', 'Year', 'number');
    t.addField('quarter', 'Quarter', 'text');
    t.addField('idx', 'Index', 'number');
    const [sy, sm] = spec.start.split('-').map(Number);
    const hist = spec.histUntil ? toDays(spec.histUntil)! : -Infinity;
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    for (let i = 0; i < spec.count; i++) {
      let y: number, mo: number, id: string, name: string, endY: number, endM: number;
      if (spec.grain === 'month') { const k = (sm - 1) + i; y = sy + Math.floor(k / 12); mo = (k % 12) + 1; id = `${MON[mo - 1]}${String(y).slice(2)}`; name = `${MON[mo - 1][0].toUpperCase()}${MON[mo - 1].slice(1)}-${String(y).slice(2)}`; endY = y; endM = mo; }
      else if (spec.grain === 'quarter') { const q0 = Math.floor((sm - 1) / 3) + i; y = sy + Math.floor(q0 / 4); const q = (q0 % 4) + 1; mo = (q - 1) * 3 + 1; id = `q${q}_${y}`; name = `Q${q} ${y}`; endY = y; endM = mo + 2; }
      else { y = sy + i; mo = 1; id = `fy${y}`; name = `FY${y}`; endY = y; endM = 12; }
      const start = Math.floor(Date.UTC(y, mo - 1, 1) / 86400000);
      const end = Math.floor(Date.UTC(endY, endM, 0) / 86400000);
      t.insertRow({ id, name, start, end, frame: end <= hist ? 'hist' : 'fcst', year: y, quarter: `Q${Math.ceil(mo / 3)} ${y}`, idx: i });
    }
    this.db.touch();
    return t;
  }

  createPivot(modelId: string, id: string, spec: { dims: { id: string; table: string; name?: string }[]; measures?: { id: string; type?: FieldType; format?: string }[]; lineDim?: string; timeDim?: string; name?: string }): Pivot {
    const m = this.model(modelId);
    const p = m.createPivot(id, spec.name);
    for (const d of spec.dims) p.addDim(d.id, m.table(d.table) as Table, d.name);
    for (const ms of spec.measures ?? [{ id: 'value' }]) { const mm = p.addMeasure(ms.id, ms.type ?? 'number'); mm.format = ms.format; }
    if (spec.lineDim) p.lineDim = p.dim(spec.lineDim);
    if (spec.timeDim) p.timeDim = p.dim(spec.timeDim);
    if (!p.timeDim) { const t = p.dims.find(d => d.table.hasField('frame') || /period/i.test(d.table.id)); if (t) p.timeDim = t; }
    this.db.schemaVersion++;
    this.db.touch();
    return p;
  }

  /** Add rules from text (one per line) or structured form. Returns per-rule results. */
  setRules(modelId: string, tableId: string, rules: string | { target: string; when?: Clause[]; formula: string; name?: string }[], opts: { strict?: boolean; replace?: boolean } = {}) {
    const m = this.model(modelId);
    const t = m.table(tableId);
    const strict = opts.strict ?? true;
    const parsed: { rule: Rule; error?: string }[] = [];
    const specs: { target: string; when: Clause[]; formula: string; name?: string }[] = [];
    if (typeof rules === 'string') {
      for (const raw of rules.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        try {
          const pr = parseRule(line);
          specs.push({ target: this.targetOf(t, pr), when: this.clausesOf(t, pr.when), formula: pr.formulaText });
        } catch (e) {
          if (strict) throw e;
          specs.push({ target: '?', when: [], formula: line, name: (e as Error).message });
        }
      }
    } else specs.push(...rules.map(r => ({ target: r.target, when: r.when ?? [], formula: r.formula, name: r.name })));
    const existing = opts.replace === false ? t.rules : [];
    let order = existing.length;
    for (const s of specs) {
      const rule: Rule = { iid: this.db.nextIid(), target: s.target, when: s.when, formula: s.formula, order: order++, name: s.name, status: 'ok' };
      try {
        rule.ast = parseRule(`x = ${s.formula}`).formula;
        this.validateTarget(t, s.target);
      } catch (e) {
        rule.status = 'invalid'; rule.error = (e as Error).message;
        if (strict) throw new CompileError('RULE_INVALID', `${s.target}: ${rule.error}`);
      }
      parsed.push({ rule, error: rule.error });
    }
    // Install the candidate rule set, smoke-test it, and roll back completely if strict mode rejects it.
    const prevRules = t.rules, prevStatus = prevRules.map(r => [r.status, r.error] as const);
    const prevComputed = t.kind === 'tabular' ? t.fields.map(f => f.computed) : [];
    t.rules = [...existing, ...parsed.map(p => p.rule)];
    t.rulesVersion++;
    if (t.kind === 'tabular') for (const r of t.rules) { const f = t.field(r.target); f.computed = true; }
    this.db.touch();
    const problems = this.smokeTest(t, parsed.map(p => p.rule));
    if (problems.length && strict) {
      t.rules = prevRules; prevRules.forEach((r, i) => { r.status = prevStatus[i][0]; r.error = prevStatus[i][1]; });
      if (t.kind === 'tabular') t.fields.forEach((f, i) => { f.computed = prevComputed[i]; });
      t.rulesVersion++;
      this.db.touch();
      const p0 = problems[0];
      throw new CompileError(p0.code, p0.message, p0.fix);
    }
    return parsed.map(p => ({ target: p.rule.target, when: p.rule.when, formula: p.rule.formula, status: p.rule.status, error: p.rule.error, fix: p.rule.fix }));
  }


  private targetOf(t: AnyTable, pr: ParsedRule): string {
    const name = pr.target[pr.target.length - 1];
    if (t.kind === 'pivot') {
      if (t.measure(name)) return t.measure(name)!.id;
      if (t.lineDim && t.lineDim.table.memberIndex(name) >= 0) { pr.when.unshift({ k: 'eq', path: [t.lineDim.id], op: '=', value: { k: 'member', v: name } }); return t.defaultMeasure.id; }
      throw new CompileError('UNKNOWN_TARGET', `'${name}' is not a measure or line item of ${t.id}`);
    }
    if (!t.hasField(name)) throw new CompileError('UNKNOWN_TARGET', `'${name}' is not a field of ${t.id}`);
    return t.field(name).id;
  }
  private validateTarget(t: AnyTable, target: string) {
    if (t.kind === 'pivot') { if (!t.measure(target)) throw new CompileError('UNKNOWN_TARGET', `'${target}' is not a measure of ${t.id}`); }
    else if (!t.hasField(target)) throw new CompileError('UNKNOWN_TARGET', `'${target}' is not a field of ${t.id}`);
  }
  private clausesOf(t: AnyTable, sels: Selector[]): Clause[] {
    const out: Clause[] = [];
    for (const s of sels) {
      switch (s.k) {
        case 'eq': {
          if (s.value.k === 'kw') throw new CompileError('BAD_CONDITION', 'rule conditions take members, not keywords');
          const left = s.path.join('.');
          // allow display-name members: normalise to id when possible
          out.push({ left, op: s.op, right: this.normaliseMember(t, s.path, s.value.v) });
          break;
        }
        case 'in': out.push({ left: s.path.join('.'), op: s.not ? 'not in' : 'in', right: s.values.map(v => this.normaliseMember(t, s.path, v)) }); break;
        case 'cmp': out.push({ left: s.path.join('.'), op: s.op, right: s.value }); break;
        default: throw new CompileError('BAD_CONDITION', `'${s.k}' selectors are not valid in a rule condition`);
      }
    }
    return out;
  }
  private normaliseMember(t: AnyTable, path: string[], v: string | number): string | number {
    if (t.kind !== 'pivot' || path.length !== 1) return v;
    const d = t.dim(path[0]);
    if (!d) return v;
    const i = d.table.memberIndex(String(v));
    return i >= 0 ? d.table.rowId(i) : v;
  }
  private static readonly COMPILE_CODES = ['UNKNOWN_NAME', 'UNKNOWN_DIM', 'SET_IN_SCALAR', 'UNPINNED_DIM', 'AMBIGUOUS_GROUP_KEY', 'NO_MEMBER', 'UNKNOWN_FUNCTION', 'BAD_PATH', 'NO_TIME_DIM', 'AMBIGUOUS_ATTRIBUTE', 'BAD_SELECTOR', 'BAD_REF', 'BAD_ARG', 'NO_PERIODS', 'BAD_CONDITION'];
  /** Evaluate one cell of each candidate rule's region; mark rules that fail to compile `invalid` and return the problems. */
  private smokeTest(t: AnyTable, candidates: Rule[]): { code: string; message: string; fix?: string }[] {
    const problems: { code: string; message: string; fix?: string }[] = [];
    const describe = (r: Rule) => `${r.target}${r.when.length ? '[' + r.when.map(c => `${c.left}${c.op}${c.right}`).join(', ') + ']' : ''} = ${r.formula}`;
    for (const r of candidates) {
      if (r.status !== 'ok') continue;
      let v: Value = null;
      if (t.kind === 'pivot') {
        if (t.totalCells() === 0) continue;
        const coord = this.firstCoordMatching(t, r);
        if (!coord) continue;
        // evaluate THIS rule at that coordinate (it may be shadowed by a later rule for the cell itself)
        v = this.evaluator.evalRule(r, { kind: 'pivot', pivot: t, coord });
      } else {
        if (t.rowCount === 0) continue;
        v = this.evaluator.evalRule(r, { kind: 'row', table: t, row: 0 });
      }
      if (isError(v) && FiniDB.COMPILE_CODES.includes(v.error)) {
        r.status = 'invalid'; r.error = v.message; r.fix = v.fix;
        problems.push({ code: v.error, message: `rule '${describe(r)}': ${v.message}`, fix: v.fix });
      }
    }
    return problems;
  }
  private firstCoordMatching(p: Pivot, r: Rule): Int32Array | undefined {
    const radices = p.radices();
    const coord = new Int32Array(p.dims.length);
    const total = p.totalCells();
    for (let a = 0; a < Math.min(total, 100000); a++) {
      let rem = a;
      for (let i = p.dims.length - 1; i >= 0; i--) { coord[i] = rem % radices[i]; rem = Math.floor(rem / radices[i]); }
      if (this.evaluator.whenMatches(r.when, { kind: 'pivot', pivot: p, coord })) return coord;
    }
    return undefined;
  }

  /** Set an input on a pivot cell. */
  setValue(modelId: string, tableId: string, at: Record<string, string>, measureOrValue: string | Scalar, value?: Scalar) {
    const t = this.model(modelId).table(tableId);
    if (t.kind === 'pivot') {
      const measure = value === undefined ? t.defaultMeasure : t.measure(String(measureOrValue))!;
      const v = value === undefined ? (measureOrValue as Scalar) : value;
      t.setInput(measure, t.coordOf(at), v);
    } else throw new Error('use setCell for tables');
  }
  setCell(modelId: string, tableId: string, rowId: string, fieldId: string, value: Scalar) {
    const t = this.model(modelId).table(tableId) as Table;
    t.setCell(rowId, fieldId, value);
    if (this.evaluator instanceof IncrementalEngine) this.evaluator.noteRowWrite(t, t.rowById.get(rowId)!, t.field(fieldId));
  }

  /** Read one pivot cell. */
  get(modelId: string, tableId: string, at: Record<string, string>, measure?: string): Value {
    const t = this.model(modelId).table(tableId);
    if (t.kind !== 'pivot') throw new Error('get() reads pivot cells; use getField for tables');
    const m = measure ? t.measure(measure)! : t.defaultMeasure;
    return this.evaluator.cell(t, m, t.coordOf(at));
  }
  getField(modelId: string, tableId: string, rowId: string, fieldId: string): Value {
    const t = this.model(modelId).table(tableId) as Table;
    const r = t.rowById.get(rowId);
    if (r === undefined) throw new Error(`DATA_NO_ROW: ${rowId}`);
    const f = t.field(fieldId);
    const v = this.evaluator.field(t, f, r);
    return f.type === 'ref' && typeof v === 'number' ? f.refTable!.rowId(v) : v;
  }

  /** Explain one cell: its value, whether it is an input or which rule governs it, and the rule's direct reads (doc 10 §5). */
  explain(modelId: string, tableId: string, at: Record<string, string>, measureId?: string): ExplainResult {
    const m = this.model(modelId);
    const t = m.table(tableId);
    const ruleText = (r: Rule) => formatRule(t, r);
    if (t.kind === 'pivot') {
      const measure = measureId ? t.measure(measureId) : t.defaultMeasure;
      if (!measure) throw new Error(`QUERY_NO_MEASURE: ${measureId}`);
      const coord = t.coordOf(at);
      const ctx = { kind: 'pivot' as const, pivot: t, coord };
      const value = this.evaluator.cell(t, measure, coord);
      const input = t.getInput(measure, coord);
      const rule = input === undefined ? this.evaluator.governingRule(t.rules, measure.id, ctx) : undefined;
      let precedents: Precedent[] = [];
      if (rule) { const tr = new TracingEvaluator(this.db); tr.traceRule(rule, ctx); precedents = tr.precedents; }
      const label: Record<string, string> = {};
      t.dims.forEach((d, i) => { label[d.id] = d.table.rowId(coord[i]); });
      const candidates = t.rules.filter(r => r.target === measure.id && r !== rule).map(r => ({ text: ruleText(r), order: r.order, status: r.status, matches: this.evaluator.whenMatches(r.when, ctx) }));
      const lineName = t.lineDim ? label[t.lineDim.id] : undefined;
      const referencedBy = lineName ? t.rules.filter(r => r !== rule && new RegExp(`\\b${lineName}\\b`).test(r.formula)).map(r => ruleText(r)) : [];
      return { table: t.id, measure: measure.id, at: label, value, source: input !== undefined ? 'input' : rule ? 'rule' : 'blank', input: input, rule: rule ? { text: ruleText(rule), order: rule.order, formula: rule.formula } : undefined, precedents, otherRules: candidates, referencedBy, error: isError(value) ? value : undefined };
    }
    const rowId = at.id ?? Object.values(at)[0];
    const row = t.rowById.get(String(rowId));
    if (row === undefined) throw new Error(`DATA_NO_ROW: ${rowId}`);
    const field = measureId ? t.field(measureId) : undefined;
    if (!field) throw new Error('explain on a table needs the field id as measure');
    const ctx = { kind: 'row' as const, table: t, row };
    const raw = this.evaluator.field(t, field, row);
    const value = field.type === 'ref' && typeof raw === 'number' ? field.refTable!.rowId(raw) : raw;
    const rule = field.computed ? this.evaluator.governingRule(t.rules, field.id, ctx) : undefined;
    let precedents: Precedent[] = [];
    if (rule) { const tr = new TracingEvaluator(this.db); tr.traceRule(rule, ctx); precedents = tr.precedents; }
    const rowValues: Record<string, Value> = {};
    for (const fl of t.fields) { const v = this.evaluator.field(t, fl, row); rowValues[fl.id] = fl.type === 'ref' && typeof v === 'number' ? fl.refTable!.rowId(v) : v; }
    return { table: t.id, measure: field.id, at: { id: String(rowId) }, value, source: field.computed ? (rule ? 'rule' : 'blank') : 'stored', rule: rule ? { text: ruleText(rule), order: rule.order, formula: rule.formula } : undefined, precedents, otherRules: [], referencedBy: [], row: rowValues, error: isError(value) ? value : undefined };
  }

  /** Query a pivot as a grid (rows × cols) and optionally render markdown. */
  query(modelId: string, q: QueryOptions): Grid | string {
    const p = this.model(modelId).table(q.table);
    if (p.kind !== 'pivot') throw new Error('query() is for pivots in M1');
    const measure = q.measure ? p.measure(q.measure) : p.defaultMeasure;
    if (!measure) throw new Error(`QUERY_NO_MEASURE: ${q.measure}`);
    const dimOf = (id: string) => { const d = p.dim(id); if (!d) throw new Error(`QUERY_NO_DIM: ${id} is not a dimension of ${p.id}`); return d; };
    const rowDims = q.rows.map(dimOf);
    const colDims = q.cols.map(dimOf);
    const memberLists = (d: Dim) => {
      const f = q.filters?.[d.id];
      const all = Array.from({ length: d.table.rowCount }, (_, i) => i);
      if (!f) return all;
      if (Array.isArray(f)) return f.map(id => d.table.memberIndex(id)).filter(i => i >= 0);   // filter order = display order
      const col = d.table.field(f.attr).column;
      const want = f.in ?? (f.eq === undefined ? [] : [f.eq]);
      return all.filter(i => { const v = col.get(i); return want.some(w => String(w).toLowerCase() === String(v ?? '').toLowerCase()); });
    };
    const rowTuples = cartesian(rowDims.map(memberLists));
    const colTuples = cartesian(colDims.map(memberLists));
    const base = new Int32Array(p.dims.length);
    for (const d of p.dims) {
      if (rowDims.includes(d) || colDims.includes(d)) continue;
      const m = q.pages?.[d.id];
      if (m === undefined) throw new Error(`QUERY_UNPINNED_DIM: ${d.id} must be on rows, cols or pages`);
      base[p.dimIndex(d)] = d.table.memberIndex(m);
    }
    // a `format` attribute on a dimension's member table is that member's default number format (e.g. is_lines.format = percent)
    const fmtCols = p.dims.map(d => d.table.hasField('format') ? d.table.field('format').column : undefined);
    const lineFormat = (rt: number[], ct: number[]): string | undefined => {
      for (let k = 0; k < rowDims.length; k++) { const c = fmtCols[p.dimIndex(rowDims[k])]; if (c) { const v = c.get(rt[k]); if (v) return String(v); } }
      for (let k = 0; k < colDims.length; k++) { const c = fmtCols[p.dimIndex(colDims[k])]; if (c) { const v = c.get(ct[k]); if (v) return String(v); } }
      return undefined;
    };
    const label = (d: Dim, i: number) => { const nf = d.table.fieldById.get('name'); const n = nf ? nf.column.get(i) : null; return n === null || n === '' ? d.table.rowId(i) : String(n); };
    const grid: Grid = {
      title: q.title,
      rowHeaderNames: rowDims.map(d => d.name),
      rowHeaders: rowTuples.map(t => t.map((i, k) => label(rowDims[k], i))),
      colHeaders: colTuples.map(t => t.map((i, k) => label(colDims[k], i)).join(' / ')),
      rowIds: rowTuples.map(t => t.map((i, k) => rowDims[k].table.rowId(i))),
      colIds: colTuples.map(t => t.map((i, k) => colDims[k].table.rowId(i))),
      values: [], formats: [], state: [],
    };
    for (const rt of rowTuples) {
      const row: Value[] = []; const fmts: (string | undefined)[] = []; const st: number[] = [];
      for (const ct of colTuples) {
        const coord = base.slice();
        rt.forEach((i, k) => coord[p.dimIndex(rowDims[k])] = i);
        ct.forEach((i, k) => coord[p.dimIndex(colDims[k])] = i);
        const v = this.evaluator.cell(p, measure, coord);
        row.push(v);
        st.push(isError(v) ? 3 : p.getInput(measure, coord) !== undefined ? 2 : v === null ? 0 : 1);
        const rowKey = rt.map((i, k) => rowDims[k].table.rowId(i)).join('/');
        fmts.push(q.formats?.[rowKey] ?? lineFormat(rt, ct) ?? measure.format);
      }
      grid.values.push(row); grid.formats!.push(fmts); grid.state!.push(st);
    }
    if (q.sort) {
      const dir = q.sort.dir === 'desc' ? -1 : 1;
      const colIdx = q.sort.by === 'header' ? -1 : grid.colIds!.findIndex(c => c.join('/') === q.sort!.by);
      if (q.sort.by !== 'header' && colIdx < 0) throw new Error(`QUERY_NO_COLUMN: ${q.sort.by}`);
      const order = grid.values.map((_, i) => i);
      const keyOf = (i: number) => colIdx < 0 ? grid.rowHeaders[i].join(' ') : grid.values[i][colIdx];
      order.sort((a, b) => { const x = keyOf(a), y = keyOf(b); const nx = typeof x === 'number' ? x : x === null ? -Infinity : NaN, ny = typeof y === 'number' ? y : y === null ? -Infinity : NaN; if (!Number.isNaN(nx) && !Number.isNaN(ny)) return (nx - ny) * dir; return String(x ?? '').localeCompare(String(y ?? '')) * dir; });
      const pick = <T,>(arr: T[]) => order.map(i => arr[i]);
      grid.rowHeaders = pick(grid.rowHeaders); grid.rowIds = pick(grid.rowIds!); grid.values = pick(grid.values); grid.formats = pick(grid.formats!); grid.state = pick(grid.state!);
      if (q.sort.top) { const n = q.sort.top; grid.rowHeaders = grid.rowHeaders.slice(0, n); grid.rowIds = grid.rowIds.slice(0, n); grid.values = grid.values.slice(0, n); grid.formats = grid.formats.slice(0, n); grid.state = grid.state.slice(0, n); }
    }
    return q.format === 'grid' ? grid : renderMarkdown(grid);
  }
}

function cartesian(lists: number[][]): number[][] {
  let out: number[][] = [[]];
  for (const l of lists) { const next: number[][] = []; for (const o of out) for (const x of l) next.push([...o, x]); out = next; }
  return out;
}

// Persistence (doc 07 §4): oplog, binary snapshots and the durable database directory.
export { OpLog, withOplog, createPersistentFiniDB, replay, applyOp, readOplog, oplogOf } from './persist/oplog.js';
export type { FsyncPolicy, OplogOptions, OpRecord, PersistentDB } from './persist/oplog.js';
export { saveSnapshot, loadSnapshot, readSnapshotHeader } from './persist/snapshot.js';
export type { SnapshotHeader } from './persist/snapshot.js';
export { openDatabase, readMeta } from './persist/store.js';
export type { OpenOptions, OpenedDatabase, StoreMeta } from './persist/store.js';

// MCP server (doc 08 §2): the nine tools and the finicast_help prompt over any FiniDB instance.
export { createMcpServer, toToolError, ruleText, HELP } from './mcp/server.js';
export type { ToolError } from './mcp/server.js';

// Server (doc 07 §1–§3): `finidb serve`, the multi-database HTTP API, users and grants.
export { startServer, runQuery, describeTable, HttpError, ROUTES } from './server/server.js';
export type { ServerOptions, ServerHandle, PersistenceHook, Op, DbEntry, ColumnarWindow, ServerQuery } from './server/server.js';
export { AuthStore, AuthError } from './server/auth.js';
export type { Role, Grant, Principal } from './server/auth.js';

export { filePersistence } from './server/persistence.js';

// Model documents (doc 08): apply an agent-written model in-process; `finidb build model.json`.
export { applyDocument, renderDocumentResult } from './build/document.js';
import { exportWorkbook, type ExportOptions, type ExportResult } from './export/workbook.js';
export { exportWorkbook } from './export/workbook.js';
export type { ExportOptions, ExportResult, DashboardExport, DashboardCardExport } from './export/workbook.js';
export { writeXlsx } from './export/xlsx.js';
export { modelLink, modelLinkPlain, parseModelLink, encodeModelFragment, decodeModelFragment } from './build/link.js';
export type { IterateSettings } from './schema/schema.js';
export { ITERATE_DEFAULTS, normalizeIterate } from './schema/schema.js';
export type { ModelDocument, PivotDoc, TableDoc, OutputDoc, DashboardDoc, DashboardCardDoc, DocumentResult } from './build/document.js';
