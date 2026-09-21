/**
 * The model document (doc 08): what an agent writes to describe a model — periods, pivots with
 * line items, historical inputs and rules, optional tables — and the outputs it wants back.
 * Applied in-process here (`finidb build model.json`); finicast.com applies the same document
 * over REST at POST /api/build.
 */
import { FiniDB, type FieldSpec, type PeriodsSpec, type Grid, type Scalar } from '../index.js';
import { formatNumber, formatValue } from '../view/markdown.js';
import { isError } from '../store/column.js';
import type { TableSource } from '../source/types.js';

export interface LineSpec { id: string; name?: string; format?: string; [attr: string]: unknown }
export interface PivotDoc {
  name?: string;                            // display name (default: title case of the id)
  lines?: (string | LineSpec)[];
  lineTable?: string;
  /** dim id → table id; `"period": false` keeps the periods dimension off a pivot (a valuation summary, a scenario table) */
  dims?: Record<string, string | false>;
  /** measure ids, or { id, type, format, name }; a `text` measure holds commentary next to the numbers */
  measures?: (string | { id: string; type?: 'number' | 'text' | 'date' | 'bool'; format?: string; name?: string })[];
  inputs?: Record<string, Record<string, Scalar>>;
  values?: { at: Record<string, string>; measure?: string; value: Scalar }[];
  rules?: string | string[];
}
export interface TableDoc {
  name?: string; fields?: Record<string, string> | FieldSpec[]; rows?: Record<string, Scalar>[]; csv?: string; distinctOf?: { table: string; field: string };
  /** rules for computed fields, e.g. `period = PERIOD(date, periods)` */
  rules?: string | string[];
  /** A linked table: rows fetched from an HTTP source (a preset such as { preset: { id: "fmp", params: { symbols: "NVDA" } } }, or url/path/map),
   *  refreshed on demand. `prefetchSources` fills `rows` before a local build; finicast.com fetches when it builds. */
  source?: TableSource;
}
export interface OutputDoc { pivot: string; title?: string; rows?: string[]; cols?: string[]; pages?: Record<string, string>; measure?: string; lines?: string[]; filters?: Record<string, string[]>; format?: 'markdown' | 'json' | 'both'; scale?: number; decimals?: number }
/** A dashboard card (built by finicast.com when the document is imported there; ignored by the local build). */
export interface DashboardCardDoc {
  /** `links`: navigation to the workspace's other dashboards, on the dashboard itself; `dashboards` lists their ids (omit for all) */
  kind?: 'table' | 'chart' | 'kpi' | 'links'; dashboards?: string[];
  /** table cards: leave out rows whose cells are all blank or zero */
  hideZeroRows?: boolean;
  /** table cards: extra columns after the view's columns, each another measure (a text commentary measure, say) at one pinned point */
  extra?: { measure?: string; label?: string; pages?: Record<string, string> }[]; type?: 'line' | 'bar' | 'stackedBar' | 'area' | 'waterfall' | 'scatter';
  title?: string; pivot: string; line?: string; lines?: string[]; periods?: string[];
  rows?: string[]; cols?: string[]; pages?: Record<string, string>; measure?: string; filters?: Record<string, string[]>;
  unit?: string; editable?: boolean; w?: number; h?: number;
}
export interface DashboardDoc { id?: string; name?: string; /** a look for the dashboard on finicast.com: default | research (equity research) | banking (a pitch-book page) | revenue (SaaS revenue ops) | controller (FP&A) | boardroom (dark) | print */ theme?: string; cards: DashboardCardDoc[] }
export interface ModelDocument {
  model?: string; name?: string; units?: string;
  /** Iterative calculation for same-period circularities (interest on average debt, a minimum-cash revolver):
   *  `true` for Excel's defaults (100 iterations, 0.001), or `{ maxIterations, tolerance }`. Off by default: a cycle is #CYCLE. */
  iterate?: boolean | { maxIterations?: number; tolerance?: number };
  periods?: PeriodsSpec;
  tables?: Record<string, TableDoc>;
  pivots?: Record<string, PivotDoc>;
  outputs?: OutputDoc[] | 'all';
  /** Dashboards for the hosted workspace: an editable table of the assumptions plus charts of the outputs, so the
   *  user changes a driver and watches the forecast move. `"auto"` derives one from the inputs and outputs. */
  dashboards?: DashboardDoc[] | 'auto';
}
export interface DocumentOutput { pivot: string; title: string; markdown?: string; json?: { rows: string[][]; rowLabels: string[][]; cols: string[]; values: unknown[][] }; /** distinct cell errors in this output, each with the engine's suggested fix */ errors?: { code: string; message?: string; fix?: string; cells: number }[] }
export interface DocumentResult { model: string; units?: string; outputs: DocumentOutput[]; log: string[] }

const TYPES = new Set(['number', 'text', 'date', 'bool']);
/** `operating_model` → `Operating model`: humans see names, not ids. */
export const titleCase = (id: string) => { const t = id.replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** Row keys that no declared field covers become fields (text, or number when every value is numeric), so `{ id, name }` rows keep their names. */
export function withRowFields(fields: FieldSpec[], rows: Record<string, unknown>[] | undefined): FieldSpec[] {
  if (!rows?.length) return fields;
  const have = new Set(['id', ...fields.map(f => f.id)]);
  const out = [...fields];
  for (const k of rows.flatMap(r => Object.keys(r))) {
    if (have.has(k)) continue;
    have.add(k);
    const vals = rows.map(r => r[k]).filter(v => v !== undefined && v !== null && v !== '');
    out.push({ id: k, type: vals.length && vals.every(v => typeof v === 'number') ? 'number' : 'text' });
  }
  return out;
}

function fieldsOf(f: TableDoc['fields']): FieldSpec[] {
  if (!f) return [];
  if (Array.isArray(f)) return f;
  return Object.entries(f).map(([id, t]) => {
    if (t.startsWith('ref:')) return t.endsWith('*') ? { id, ref: t.slice(4, -1), computed: true } : { id, ref: t.slice(4) };
    if (t.endsWith('*')) return { id, type: (TYPES.has(t.slice(0, -1)) ? t.slice(0, -1) : 'number') as FieldSpec['type'], computed: true };
    return { id, type: (TYPES.has(t) ? t : 'text') as FieldSpec['type'] };
  });
}

/** Apply a model document to a FiniDB instance (creating what does not exist) and produce the requested outputs. */
export function applyDocument(f: FiniDB, doc: ModelDocument): DocumentResult {
  const log: string[] = [];
  const modelId = doc.model ?? 'model';
  if (!f.db.models.has(modelId)) { f.createModel(modelId, doc.name ?? modelId); log.push(`model ${modelId}`); }
  if (doc.iterate !== undefined) { const it = f.setIterate(modelId, doc.iterate); log.push(it ? `iterate: up to ${it.maxIterations} passes, tolerance ${it.tolerance}` : 'iterate: off'); }
  const m = f.model(modelId);
  const has = (id: string) => m.hasTable(id);

  if (doc.periods && !has('periods')) { f.createPeriods(modelId, 'periods', doc.periods); log.push(`periods: ${doc.periods.count} ${doc.periods.grain}s from ${doc.periods.start}`); }

  for (const [id, t] of Object.entries(doc.tables ?? {})) {
    if (has(id)) continue;
    if (t.distinctOf) { f.createDistinctTable(modelId, id, t.distinctOf.table, t.distinctOf.field); log.push(`table ${id} (distinct of ${t.distinctOf.table}.${t.distinctOf.field})`); continue; }
    if (t.csv) {
      const { parseCsv, planLoad } = require_csv();
      const plan = planLoad(parseCsv(t.csv), { candidates: candidateIds(f, modelId) });
      const made = f.createTable(modelId, id, plan.fields as FieldSpec[], { name: t.name ?? titleCase(id), rows: plan.rows });
      for (const spec of fieldsOf(t.fields)) if (!made.hasField(spec.id)) f.addField(made, spec);   // declared computed fields (e.g. period = PERIOD(date)) on top of the CSV's columns
      log.push(`table ${id}: ${plan.rows.length} rows from CSV`);
      continue;
    }
    f.createTable(modelId, id, withRowFields(fieldsOf(t.fields), t.rows), { name: t.name ?? titleCase(id), rows: t.rows ?? [] });
    if (t.source) { f.setSource(modelId, id, t.source); log.push(`table ${id}: ${(t.rows ?? []).length} rows, linked to ${t.source.preset ? `${t.source.preset.id} ${JSON.stringify(t.source.preset.params)}` : t.source.url ?? 'a source'}`); continue; }
    log.push(`table ${id}: ${(t.rows ?? []).length} rows`);
  }

  for (const [id, t] of Object.entries(doc.tables ?? {})) {
    if (!t.rules) continue;
    const text = Array.isArray(t.rules) ? t.rules.join('\n') : t.rules;
    const r = f.setRules(modelId, id, text, { replace: true });
    log.push(`${id}: ${r.length} rules`);
  }
  for (const [id, p] of Object.entries(doc.pivots ?? {})) {
    if (!has(id)) {
      const dims: { id: string; table: string }[] = [];
      let lineTable = p.lineTable;
      if (p.lines) {
        lineTable = `${id}_lines`;
        const lines = p.lines.map(l => typeof l === 'string' ? { id: l } as LineSpec : l);
        const attrs = [...new Set(lines.flatMap(l => Object.keys(l).filter(k => k !== 'id')))];
        if (!attrs.includes('name')) attrs.unshift('name');
        if (!attrs.includes('format')) attrs.push('format');
        f.createTable(modelId, lineTable, attrs.map(a => ({ id: a, type: 'text' as const })), {
          name: `${p.name ?? titleCase(id)} lines`,
          rows: lines.map(l => ({ ...Object.fromEntries(attrs.map(a => [a, (l[a] as Scalar) ?? null])), id: l.id, name: (l.name as string) ?? l.id.replace(/_/g, ' ') })),
        });
      }
      if (lineTable) dims.push({ id: 'line', table: lineTable });
      for (const [d, table] of Object.entries(p.dims ?? {})) if (table) dims.push({ id: d, table });
      if (has('periods') && !dims.some(d => d.id === 'period') && p.dims?.period !== false) dims.push({ id: 'period', table: 'periods' });
      if (!dims.length) throw new Error(`NO_DIMS: pivot ${id} needs lines, dims or periods`);
      f.createPivot(modelId, id, { dims, measures: (p.measures ?? ['value']).map(x => typeof x === 'string' ? { id: x } : x), lineDim: lineTable ? 'line' : undefined, timeDim: dims.some(d => d.id === 'period') ? 'period' : undefined, name: p.name ?? titleCase(id) });
      log.push(`pivot ${id}: ${dims.map(d => d.id).join(' × ')}`);
    }
    let n = 0;
    for (const [line, byPeriod] of Object.entries(p.inputs ?? {})) for (const [period, value] of Object.entries(byPeriod)) { f.setValue(modelId, id, { line, period }, value); n++; }
    for (const v of p.values ?? []) { if (v.measure) f.setValue(modelId, id, v.at, v.measure, v.value); else f.setValue(modelId, id, v.at, v.value); n++; }
    if (n) log.push(`${id}: ${n} inputs`);
  }
  for (const [id, p] of Object.entries(doc.pivots ?? {})) {
    if (!p.rules) continue;
    const text = Array.isArray(p.rules) ? p.rules.join('\n') : p.rules;
    const r = f.setRules(modelId, id, text, { replace: true });
    log.push(`${id}: ${r.length} rules`);
  }

  const outs: OutputDoc[] = doc.outputs === 'all' || !doc.outputs ? Object.keys(doc.pivots ?? {}).map(pivot => ({ pivot })) : doc.outputs;
  const outputs: DocumentOutput[] = [];
  for (const o of outs) {
    const pv = m.table(o.pivot);
    if (pv.kind !== 'pivot') throw new Error(`NO_PIVOT: output ${o.pivot} is not a pivot`);
    const rows = o.rows ?? [pv.lineDim?.id ?? pv.dims[0].id];
    const cols = o.cols ?? (pv.dims.length > 1 ? [pv.timeDim?.id ?? pv.dims.find(d => d.id !== rows[0])!.id] : []);
    const pages: Record<string, string> = { ...(o.pages ?? {}) };
    for (const d of pv.dims) if (!rows.includes(d.id) && !cols.includes(d.id) && !pages[d.id]) pages[d.id] = d.table.rowId(0);
    const filters: Record<string, string[]> = { ...(o.filters ?? {}) };
    if (o.lines && pv.lineDim) filters[pv.lineDim.id] = o.lines;
    const title = o.title ?? pv.name ?? o.pivot;
    const grid = f.query(modelId, { table: o.pivot, rows, cols, pages, measure: o.measure, filters, title, format: 'grid' }) as Grid;
    const entry: DocumentOutput = { pivot: o.pivot, title };
    const fmt = o.format ?? 'markdown';
    if (fmt === 'markdown' || fmt === 'both') entry.markdown = gridMarkdown(grid, title, o);
    if (fmt === 'json' || fmt === 'both') entry.json = { rows: grid.rowIds ?? [], rowLabels: grid.rowHeaders, cols: (grid.colIds ?? []).map(c => c.join('/')), values: grid.values.map(r => r.map(v => isError(v) ? `#${v.error}` : v)) };
    const errs = new Map<string, { code: string; message?: string; fix?: string; cells: number }>();
    grid.values.forEach(row => row.forEach(v => { if (isError(v)) { const k = `${v.error}|${v.message ?? ''}|${v.fix ?? ''}`; const e = errs.get(k); if (e) e.cells++; else errs.set(k, { code: v.error, message: v.message, fix: v.fix, cells: 1 }); } }));
    if (errs.size) entry.errors = [...errs.values()];
    outputs.push(entry);
  }
  return { model: modelId, units: doc.units, outputs, log };
}

function gridMarkdown(g: Grid, title: string, o: OutputDoc): string {
  const scale = o.scale ?? 1;
  const head = `| ${g.rowHeaderNames.join(' / ') || 'line'} | ${g.colHeaders.join(' | ')} |`;
  const sep = `|---|${g.colHeaders.map(() => '---:').join('|')}|`;
  const body = g.values.map((row, r) => `| ${g.rowHeaders[r].join(' / ')} | ${row.map((v, c) => {
    const fmt = g.formats?.[r]?.[c];
    if (typeof v === 'number' && fmt !== 'percent' && fmt !== '%') { const x = v / scale; return o.decimals !== undefined ? formatNumber(x, o.decimals) : formatValue(x, Math.abs(x) >= 100 ? 'int' : undefined); }
    return formatValue(v, fmt);
  }).join(' | ')} |`);
  return `### ${title}\n\n${head}\n${sep}\n${body.join('\n')}`;
}

export interface RenderOptions {
  url?: string;              // hosted: the workspace url
  link?: string;             // local: the share link that carries the model
  dashboard?: boolean;       // the document declares a dashboard
  xlsx?: string;             // path (local) or url (hosted) of the Excel workbook
  linkVerified?: boolean;    // the link was decoded back and matched the document
  rules?: number;            // rule count, for the framing line
  xlsxHint?: boolean;        // no workbook was written: say how to get one
}
/** The statements, then a deliverables block the agent can hand over as-is, then how to describe the result. */
export function renderDocumentResult(r: DocumentResult, opts: RenderOptions = {}): string {
  const parts = r.outputs.map(o => (o.markdown ?? `### ${o.title}\n\n\`\`\`json\n${JSON.stringify(o.json)}\n\`\`\``) + (o.errors?.length ? '\n\n' + o.errors.map(e => `Error #${e.code} in ${e.cells} cell${e.cells === 1 ? '' : 's'}${e.message ? `: ${e.message}` : ''}${e.fix ? ` — fix: ${e.fix}` : ''}`).join('\n') : ''));
  const lines: string[] = [];
  if (r.units) lines.push(`Units: ${r.units}.`);
  lines.push('', 'Deliverables');
  const opens = opts.dashboard ? 'opens a dashboard where the user edits the assumptions and every statement follows' : 'opens the model in an editable workspace';
  if (opts.url) lines.push(`- Live model: ${opts.url} — ${opens}.`);
  else if (opts.link) lines.push(`- Live model: ${opts.link}`, `  Put this link in your reply verbatim; it carries the whole model and ${opens}.${opts.linkVerified ? ' Verified: the link decodes back to exactly this document.' : ''}`);
  else lines.push('- Live model: paste this document at https://finicast.com/import (or POST it to https://finicast.com/api/build).');
  if (opts.xlsx) lines.push(`- Excel workbook: ${opts.xlsx} — ${opts.url ? 'a download link for the user' : 'attach this file to your reply'}. Live formulas compiled from the rules, inputs blue, formulas black, dashboards as sheets with native charts.`);
  else if (opts.xlsxHint) lines.push('- Excel workbook: rerun with --xlsx model.xlsx (live formulas compiled from the rules; the hosted workspace also has a Download Excel button).');
  lines.push('- The statements above.');
  lines.push('', `How to describe it: the user gets a live model to steer and a workbook they can audit, restyle and extend, both generated from the same ${opts.rules ? `${opts.rules} ` : ''}rules — one rule per line item covers every forecast period, so there are no cell formulas to get wrong. Say what the drivers are and invite the user to change them.`);
  return `${parts.join('\n\n')}\n\n${lines.join('\n')}\n`;
}

function candidateIds(f: FiniDB, modelId: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const t of f.model(modelId).tables.values()) if (t.kind === 'tabular') out[t.id] = new Set(t.rowById.keys());
  return out;
}
function require_csv() { return csvModule; }
import * as csvModule from '../store/csv.js';
