/**
 * FiniDB MCP server: the nine tools of doc 08 §2 plus the `finicast_help` prompt.
 *
 * Design rules from doc 08: each tool description carries its decision criteria in the first
 * sentence; results are compact (schema is never echoed back, per-cell metadata is never returned
 * unless asked); markdown is the default query output; errors are structured `{ code, message, fix }`
 * so the agent applies the fix instead of retrying the same text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FiniDB, CompileError, ParseError, isError, renderMarkdown } from '../index.js';
import type { Grid, Value, Scalar, Clause, Rule, Table, Pivot, FieldSpec } from '../index.js';
import { parseCsv, planLoad, type ParsedCsv } from '../store/csv.js';

// ---------- result plumbing ----------

/** Text-only MCP result; JSON bodies are compact because the agent pays for every byte (doc 08 §5). */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export interface ToolError { code: string; message: string; fix?: string }

const text = (s: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) });
const json = (body: unknown, isError = false): ToolResult => text(JSON.stringify(body), isError);

/** Normalise any thrown error to the doc 04 §7 shape. Engine errors are `CODE: detail`; parser errors get code PARSE. */
export function toToolError(e: unknown): ToolError {
  if (e instanceof CompileError) {
    const message = e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message;
    const fix = e.fix ?? suggestFix(e.code, message);
    return fix ? { code: e.code, message, fix } : { code: e.code, message };
  }
  if (e instanceof ParseError) return { code: 'PARSE', message: `${e.message} (at offset ${e.pos})`, fix: 'one rule per line: target[condition] = expression; quote names with spaces in single quotes' };
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(msg);
  return m ? { code: m[1], message: m[2] } : { code: 'ERROR', message: msg };
}

/**
 * The engine drops `fix` when a CompileError is converted to a cell error (reference.ts catch site),
 * so the two codes whose messages carry enough information get their fix rebuilt here.
 */
function suggestFix(code: string, message: string): string | undefined {
  if (code === 'AMBIGUOUS_GROUP_KEY') {
    const m = /(\w+\.\w+) can reach dimension '(\w+)' \d+ ways: ([^,]+)/.exec(message);
    if (m) return `${m[1]}[${m[3].trim()}=@${m[2]}]`;
  }
  if (code === 'SET_IN_SCALAR') {
    const m = /(\w+\.\w+) refers to/.exec(message);
    if (m) return `SUM(${m[1]})  // or pin every dimension, e.g. ${m[1]}[dim=member]`;
  }
  if (code === 'UNKNOWN_NAME' && /line item/.test(message)) return 'check finicast_schema for the exact line-item ids; ids are case-sensitive and snake_case';
  return undefined;
}

const guard = (fn: () => ToolResult | Promise<ToolResult>): ToolResult | Promise<ToolResult> => {
  try { return fn(); } catch (e) { return json({ ok: false, errors: [toToolError(e)] }, true); }
};

// ---------- shared helpers ----------

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldType = z.enum(['number', 'text', 'date', 'bool']);

/** Render a rule back to the doc 04 text form. */
export function ruleText(r: Pick<Rule, 'target' | 'when' | 'formula'>): string {
  const cond = r.when.map((c: Clause) => Array.isArray(c.right) ? `${c.left} ${c.op} (${c.right.join(', ')})` : `${c.left}${c.op === '=' || c.op === '!=' ? c.op : ` ${c.op} `}${c.right}`);
  return `${r.target}${cond.length ? `[${cond.join(', ')}]` : ''} = ${r.formula}`;
}

function fieldSig(t: Table): string {
  return t.fields.map(f => f.id + (f.type === 'ref' ? `→${f.refTable!.id}` : f.type === 'text' ? '' : `:${f.type}`) + (f.computed ? '*' : '')).join(', ');
}

/** doc 08 §2: the whole database in ~100 tokens when empty; tables, fields, dims, measures, rules, row counts. */
function describeSchema(f: FiniDB, modelId?: string): string {
  const models = modelId ? [f.model(modelId)] : [...f.db.models.values()];
  if (models.length === 0) return 'Empty database: no models. Call finicast_create_model, then finicast_load_table.';
  const out: string[] = [];
  for (const m of models) {
    out.push(`model ${m.id}${m.name !== m.id ? ` (${m.name})` : ''}`);
    for (const t of m.tables.values()) {
      if (t.kind === 'tabular') {
        out.push(`  table ${t.id} (${t.rowCount} rows): ${fieldSig(t)}${t.distinctOf ? `  [distinct of ${t.distinctOf.table.id}.${t.distinctOf.field.id}]` : ''}`);
      } else {
        const dims = t.dims.map(d => `${d.id}→${d.table.id}(${d.table.rowCount})`).join(' × ');
        const flags = [t.lineDim ? `lineDim ${t.lineDim.id}` : '', t.timeDim ? `timeDim ${t.timeDim.id}` : ''].filter(Boolean).join(', ');
        out.push(`  pivot ${t.id}: ${dims}; measures ${t.measures.map(x => x.id + (x.format ? `:${x.format}` : '')).join(', ')}${flags ? `; ${flags}` : ''}; ${t.rules.length} rules`);
      }
      for (const r of t.rules) out.push(`    ${r.status === 'invalid' ? '!! ' : ''}${ruleText(r)}${r.status === 'invalid' ? `  // INVALID: ${r.error}` : ''}`);
    }
  }
  out.push('(* = computed field; → = reference to table)');
  return out.join('\n');
}

/** Inline rows → the ParsedCsv shape so both sources share planLoad's inference and ref detection. */
function inlineToCsv(rows: Record<string, Scalar>[]): ParsedCsv {
  const header: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
  const cell = (v: Scalar | undefined) => v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return { header, rows: rows.map(r => header.map(h => cell(r[h]))) };
}

const CAP_CHARS = 16_000; // ≈ 4,000 tokens (doc 08 §3)

/** Truncate to the response cap on a line boundary and say so, so the agent narrows the query. */
function capped(s: string, unit: string): string {
  if (s.length <= CAP_CHARS) return s;
  const cut = s.lastIndexOf('\n', CAP_CHARS);
  return s.slice(0, cut > 0 ? cut : CAP_CHARS) + `\n[response capped at ~4,000 tokens; ${unit} omitted — narrow with filters, pages or maxRows]`;
}

const plain = (v: Value): Scalar | { error: string } => isError(v) ? { error: v.error } : v;

// ---------- the server ----------

export function createMcpServer(f: FiniDB): McpServer {
  const server = new McpServer({ name: 'finidb', version: '0.1.7' });

  // 1. schema ---------------------------------------------------------------
  server.registerTool('finicast_schema', {
    title: 'FiniDB schema',
    description: 'Call this first in any session, before guessing what exists: returns every model, table (fields, row counts), pivot (dims, measures, lineDim/timeDim) and rule in the FiniDB database, compactly. Use FiniDB for line items × periods with formulas, forecasts, budgets, plans, financial statements, ledgers rolled into a live plan, or anything a human will open and adjust; not for one-off arithmetic on a few numbers, data cleaning/joins (Pandas, DuckDB), ad-hoc SQL or static charts.',
    inputSchema: { model: z.string().optional().describe('Restrict to one model') },
  }, ({ model }) => guard(() => text(describeSchema(f, model))));

  // 2. create_model ---------------------------------------------------------
  server.registerTool('finicast_create_model', {
    title: 'Create model',
    description: 'Create a model (a namespace of tables, pivots and rules) when starting a new forecast, budget, plan or sales-ops framework; call once per model, before finicast_load_table. Local mode: no workspace URL is returned.',
    inputSchema: { model: z.string().describe('snake_case id, e.g. nvda'), description: z.string().optional(), iterate: z.union([z.boolean(), z.object({ maxIterations: z.number().optional(), tolerance: z.number().optional() })]).optional().describe('Iterative calculation for same-period circularities (interest on average debt, a minimum-cash revolver): true for Excel defaults (100 passes, 0.001). Off by default; a cycle is then #CYCLE.') },
  }, ({ model, description, iterate }) => guard(() => { const m = f.createModel(model, description ?? model); if (iterate !== undefined) f.setIterate(model, iterate); return json({ ok: true, model: m.id, url: null, next: 'finicast_load_table your data, then finicast_define_pivot' }); }));

  // 3. load_table -----------------------------------------------------------
  server.registerTool('finicast_load_table', {
    title: 'Load table',
    description: 'Load a tabular table from CSV text or inline rows (ledgers, filings, hires, activities, dimension lists) and get back a profile — inferred types, distinct counts, samples, and columns detected as references to existing tables — so you can decide the pivot shape without another round trip. Load dimension/lookup tables (or generate periods via finicast_define_pivot) before the fact tables that reference them. Prefer loading raw rows plus a rule over loading pre-aggregated numbers: the aggregate then stays live.',
    inputSchema: {
      model: z.string(),
      table: z.string().describe('snake_case table id'),
      source: z.object({
        csv: z.string().optional().describe('CSV text with a header row'),
        inline: z.array(z.record(z.string(), scalar)).optional().describe('Rows as objects; include an "id" key for dimension tables'),
      }),
      options: z.object({
        name: z.string().optional(),
        idColumn: z.string().optional().describe('Column to use as the row id (default: a unique id-like column, else generated)'),
        types: z.record(z.string(), fieldType).optional().describe('Force a column type, keyed by slugged column id'),
        refs: z.record(z.string(), z.string()).optional().describe('Force a column to reference a table: { column: table }'),
        computed: z.array(z.object({ id: z.string(), type: fieldType.optional(), ref: z.string().optional() })).optional().describe('Empty computed fields to define later with finicast_set_rules (e.g. score, period=PERIOD(date, periods))'),
      }).optional(),
    },
  }, ({ model, table, source, options }) => guard(() => {
    const m = f.model(model);
    const csv = source.csv !== undefined ? parseCsv(source.csv) : source.inline ? inlineToCsv(source.inline) : undefined;
    if (!csv) throw new Error('BAD_SOURCE: source needs csv or inline');
    const candidates: Record<string, Set<string>> = {};
    for (const t of m.tables.values()) if (t.kind === 'tabular' && t.id !== table && t.rowCount > 0) candidates[t.id] = new Set(t.rowById.keys());
    const plan = planLoad(csv, { idColumn: options?.idColumn, types: options?.types, refs: options?.refs, candidates });
    const fields: FieldSpec[] = plan.fields.map(fl => fl.ref ? { id: fl.id, name: fl.name, ref: fl.ref } : { id: fl.id, name: fl.name, type: fl.type });
    for (const c of options?.computed ?? []) fields.push({ id: c.id, name: c.id, ...(c.ref ? { ref: c.ref } : { type: c.type ?? 'number' }), computed: true });
    const t = f.createTable(model, table, fields, { name: options?.name, rows: plan.rows });
    const profile = plan.profile.map(p => {
      const fl = plan.fields.find(x => x.id === p.id);
      return { id: p.id === plan.idColumn ? 'id' : p.id, name: p.name, type: fl?.ref ? 'ref' : p.type, distinct: p.distinct, nulls: p.nullCount || undefined, sample: p.sample, ...(fl?.ref ? { refCandidate: fl.ref } : {}) };
    });
    return json({ ok: true, table: t.id, rows: t.rowCount, idColumn: plan.idColumn ?? '(generated)', fields: profile, computed: (options?.computed ?? []).map(c => c.id), warnings: plan.warnings });
  }));

  // 4. define_pivot ---------------------------------------------------------
  const periodsSpec = z.object({
    start: z.string().describe('YYYY-MM of the first period'),
    count: z.number().int().positive(),
    grain: z.enum(['month', 'quarter', 'year']),
    histUntil: z.string().optional().describe('YYYY-MM-DD; periods ending on or before get frame=hist, later ones frame=fcst'),
  });
  server.registerTool('finicast_define_pivot', {
    title: 'Define pivot',
    description: 'Define the model grid — canonically line items × periods with one measure named value — once the source tables are loaded. Each dim comes from an existing table, from { distinctOf: "table.field" } (creates the dimension table from a column\'s distinct values), or from { periods: { start, count, grain, histUntil } } (generates a periods table with frame=hist|fcst, year, quarter, idx). Model line items as a dimension (a table of ids like revenue, cogs, gross_profit), not as measures.',
    inputSchema: {
      model: z.string(),
      table: z.string().describe('pivot id, e.g. income_statement'),
      dims: z.array(z.object({
        id: z.string().describe('dimension id used in rules, e.g. line, period'),
        from: z.union([z.string(), z.object({ distinctOf: z.string() }), z.object({ periods: periodsSpec })]),
        table: z.string().optional().describe('id for a table created by distinctOf/periods (defaults: the dim id / "periods")'),
      })).min(1),
      measures: z.array(z.object({ id: z.string(), format: z.string().optional().describe('percent | int') })).optional().describe('default [{ id: "value" }]'),
      lineDim: z.string().optional().describe('the line-item dimension (default: first dim that is not the time dim)'),
      timeDim: z.string().optional().describe('the period dimension (auto-detected from a frame attribute)'),
    },
  }, ({ model, table, dims, measures, lineDim, timeDim }) => guard(() => {
    const m = f.model(model);
    const created: string[] = [];
    const resolved = dims.map(d => {
      if (typeof d.from === 'string') return { id: d.id, table: m.table(d.from).id };
      if ('distinctOf' in d.from) {
        const [src, field] = d.from.distinctOf.split('.');
        if (!field) throw new Error('BAD_DIM: distinctOf must be "table.field"');
        const t = f.createDistinctTable(model, d.table ?? d.id, src, field);
        created.push(`${t.id} (${t.rowCount} distinct values of ${src}.${field})`);
        return { id: d.id, table: t.id };
      }
      const tid = d.table ?? 'periods';
      if (m.hasTable(tid)) throw new Error(`SCHEMA_DUPLICATE_TABLE: ${tid} exists; pass from: "${tid}" to reuse it or table: "<new id>"`);
      const t = f.createPeriods(model, tid, d.from.periods);
      created.push(`${t.id} (${t.rowCount} ${d.from.periods.grain}s from ${t.rowId(0)} to ${t.rowId(t.rowCount - 1)}${d.from.periods.histUntil ? `, hist until ${d.from.periods.histUntil}` : ''})`);
      return { id: d.id, table: t.id };
    });
    const p = f.createPivot(model, table, { dims: resolved, measures, lineDim, timeDim });
    if (!p.lineDim) p.lineDim = p.dims.find(d => d !== p.timeDim) ?? p.dims[0];
    return json({
      ok: true, pivot: p.id, cells: p.totalCells(),
      dims: p.dims.map(d => ({ id: d.id, table: d.table.id, members: d.table.rowCount, attributes: d.table.fields.filter(x => x.id !== 'id').map(x => x.id) })),
      measures: p.measures.map(x => x.id), lineDim: p.lineDim?.id ?? null, timeDim: p.timeDim?.id ?? null,
      created, next: 'finicast_set_rules with all rules in one call',
    });
  }));

  // 5. set_rules ------------------------------------------------------------
  const clause = z.object({ left: z.string(), op: z.enum(['=', '!=', 'in', 'not in', '<', '<=', '>', '>=']), right: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]) });
  server.registerTool('finicast_set_rules', {
    title: 'Set rules',
    description: 'Send the whole model as one batch of rules (one call, not one per rule) after finicast_define_pivot; by default replaces the table\'s rules. Text form, one rule per line: `target[condition] = expression`, e.g. `revenue[frame=fcst] = PREV(revenue) * (1 + assumptions.growth)`, `gross_profit = revenue - cogs`, `opex = SUM(value[line.category = opex])`, `points = SUM(activities.score)`. Later rules on the same target win; inputs beat rules. On error apply the returned `fix` and resend the full batch rather than retrying the same text.',
    inputSchema: {
      model: z.string(),
      table: z.string().describe('pivot or table id'),
      rules: z.union([z.string(), z.array(z.object({ target: z.string(), when: z.array(clause).optional(), formula: z.string(), name: z.string().optional() }))]),
      strict: z.boolean().optional().describe('default true: reject the batch on the first error. false: store invalid rules marked invalid'),
      replace: z.boolean().optional().describe('default true: replace all rules of the table; false: append'),
    },
  }, ({ model, table, rules, strict, replace }) => guard(() => {
    // doc 04 §7: in strict mode the batch is rejected as a whole. The facade can leave the failing
    // rule appended and, because its smoke test attributes a cell error to whichever existing rule
    // it was checking, mark an older rule invalid; restore the previous list and statuses.
    const t = f.model(model).table(table);
    const previous = t.rules.map(r => ({ r, status: r.status, error: r.error }));
    let res: ReturnType<FiniDB['setRules']>;
    try { res = f.setRules(model, table, rules, { strict, replace }); }
    catch (e) {
      if (strict !== false) { t.rules = previous.map(p => { p.r.status = p.status; p.r.error = p.error; return p.r; }); t.rulesVersion++; f.db.touch(); }
      throw e;
    }
    const errors = res.filter(r => r.status === 'invalid').map(r => ({ code: 'RULE_INVALID', message: `${ruleText(r)}: ${r.error}` }));
    return json({ ok: errors.length === 0, compiled: res.map(r => `${r.status === 'invalid' ? '!! ' : ''}${ruleText(r)}`), errors }, errors.length > 0);
  }));

  // 6. set_values -----------------------------------------------------------
  server.registerTool('finicast_set_values', {
    title: 'Set values',
    description: 'Enter inputs and overrides in one batch: driver assumptions (growth rates, margins), plan numbers, or a manual override of a computed cell (an input always beats a rule). For a pivot pass values: [{ at: { line, period }, value }]; for a tabular table pass rows: [{ id, field: value }] (existing ids are updated, new ids inserted). Set value to null to clear an override.',
    inputSchema: {
      model: z.string(), table: z.string(),
      values: z.array(z.object({ at: z.record(z.string(), z.string()).describe('{ dimId: memberId } for every dim'), value: scalar, measure: z.string().optional() })).optional(),
      rows: z.array(z.record(z.string(), scalar)).optional(),
    },
  }, ({ model, table, values, rows }) => guard(() => {
    const t = f.model(model).table(table);
    let set = 0, inserted = 0;
    if (t.kind === 'pivot') {
      if (!values?.length) throw new Error('BAD_ARG: a pivot takes values: [{ at, value }]');
      for (const v of values) { if (v.measure) f.setValue(model, table, v.at, v.measure, v.value); else f.setValue(model, table, v.at, v.value); set++; }
    } else {
      if (!rows?.length) throw new Error('BAD_ARG: a table takes rows: [{ id, field: value }]');
      for (const r of rows) {
        const id = r.id === undefined || r.id === null ? undefined : String(r.id);
        if (id !== undefined && t.rowById.has(id)) { for (const [k, v] of Object.entries(r)) if (k !== 'id') { f.setCell(model, table, id, k, v); set++; } }
        else { f.insertRows(t, [r]); inserted++; }
      }
    }
    return json({ ok: true, table: t.id, set, inserted });
  }));

  // 7. query ----------------------------------------------------------------
  server.registerTool('finicast_query', {
    title: 'Query pivot',
    description: 'Read a pivot as a table — this markdown is the deliverable; return it to the user verbatim (and the URL when one exists). Put dims on rows/cols, pin any other dim with pages, restrict members with filters, and use maxRows/scale to keep the response small; results are capped at ~4,000 tokens, so narrow the query if the cap is reported. Forecast-frame columns are suffixed E.',
    inputSchema: {
      model: z.string(), table: z.string().describe('pivot id'),
      rows: z.array(z.string()).describe('dim ids on rows, e.g. ["line"]'),
      cols: z.array(z.string()).describe('dim ids on columns, e.g. ["period"]'),
      pages: z.record(z.string(), z.string()).optional().describe('{ dimId: memberId } for dims not on rows/cols'),
      measure: z.string().optional(),
      filters: z.record(z.string(), z.array(z.string())).optional().describe('{ dimId: [memberIds] } to keep'),
      formats: z.record(z.string(), z.string()).optional().describe('{ rowMemberId: "percent" | "int" }'),
      title: z.string().optional(),
      format: z.enum(['markdown', 'json']).optional().describe('default markdown'),
      maxRows: z.number().int().positive().optional().describe('default 60'),
      scale: z.number().optional().describe('divide numbers by this, e.g. 1000'),
    },
  }, ({ model, table, rows, cols, pages, measure, filters, formats, title, format, maxRows, scale }) => guard(() => {
    const p = f.model(model).table(table);
    if (p.kind !== 'pivot') throw new Error('NOT_A_PIVOT: finicast_query reads pivots; tabular rows are read with finicast_explain { at: { id } }');
    const grid = f.query(model, { table, rows, cols, pages, measure, filters, formats, format: 'grid', title: title ?? `${f.model(model).name} — ${p.name}` }) as Grid;
    if (scale) grid.values = grid.values.map(r => r.map(v => typeof v === 'number' ? v / scale : v));
    markForecastColumns(p, cols, filters, grid);
    const limit = maxRows ?? 60;
    const omitted = Math.max(0, grid.values.length - limit);
    if (omitted) { grid.values = grid.values.slice(0, limit); grid.rowHeaders = grid.rowHeaders.slice(0, limit); grid.formats = grid.formats?.slice(0, limit); }
    const more = omitted ? `\n… ${omitted} more rows (raise maxRows or add filters)` : '';
    if (format === 'json') {
      const body = { title: grid.title, rowDims: grid.rowHeaderNames, rows: grid.rowHeaders, cols: grid.colHeaders, values: grid.values.map(r => r.map(plain)), omittedRows: omitted };
      return text(capped(JSON.stringify(body), 'rows'));
    }
    return text(capped(renderMarkdown(grid) + more, 'rows'));
  }));

  // 8. explain --------------------------------------------------------------
  server.registerTool('finicast_explain', {
    title: 'Explain cell',
    description: 'Explain one cell when a number looks wrong or the user asks why: returns its value, whether it is an input or which rule governs it (with the rule text), the same-cell values of line items the rule reads, any cell error, and the engine\'s cost counters. For a tabular table pass at: { id: rowId } and measure: fieldId.',
    inputSchema: { model: z.string(), table: z.string(), at: z.record(z.string(), z.string()).describe('{ dimId: memberId } for every dim (pivot) or { id: rowId } (table)'), measure: z.string().optional() },
  }, ({ model, table, at, measure }) => guard(() => json(explain(f, model, table, at, measure))));

  // 9. share ----------------------------------------------------------------
  server.registerTool('finicast_share', {
    title: 'Share model',
    description: 'Get a URL a human can open to view and adjust the model, after finicast_query; always return the markdown table and the URL together. In local mode publishing is not configured and no URL exists — say so instead of inventing one.',
    inputSchema: { model: z.string(), view: z.string().optional() },
  }, ({ model }) => guard(() => { f.model(model); return json({ ok: false, url: null, message: 'Publishing is not configured: this FiniDB runs locally with no hosted workspace, so there is no URL. Deliver the finicast_query markdown; a hosted server (doc 08 §1) returns a URL from the same call.' }); }));

  // prompt ------------------------------------------------------------------
  server.registerPrompt('finicast_help', { title: 'FiniDB help', description: 'The FiniDB workflow, syntax cheat-sheet and recipe index for an agent without the skill file.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: HELP } }] }));

  return server;
}

// ---------- query helpers ----------

/** doc 08 §3: an `E` suffix on forecast columns when the column dim carries a frame attribute. */
function markForecastColumns(p: Pivot, cols: string[], filters: Record<string, string[]> | undefined, grid: Grid) {
  if (cols.length !== 1) return;
  const d = p.dim(cols[0]);
  const frame = d?.table.fieldById.get('frame');
  if (!d || !frame) return;
  const keep = filters?.[d.id];
  const all = Array.from({ length: d.table.rowCount }, (_, i) => i);
  if (!all.some(i => frame.column.get(i) === 'hist')) return; // no actual/forecast split to mark
  const members = all.filter(i => !keep || keep.includes(d.table.rowId(i)));
  grid.colHeaders = grid.colHeaders.map((h, k) => frame.column.get(members[k]) === 'fcst' ? `${h}E` : h);
}

/** doc 08 §2 finicast_explain: value, governing rule, same-cell precedents, error, counters. */
function explain(f: FiniDB, model: string, table: string, at: Record<string, string>, measure?: string) {
  const before = { ...f.evaluator.counters };
  const r = f.explain(model, table, at, measure);
  const plain = (v: unknown) => (v !== null && typeof v === 'object' && 'error' in (v as object)) ? { error: (v as any).error, message: (v as any).message } : v;
  return {
    table: r.table, measure: r.measure, at: r.at, value: plain(r.value), source: r.source, input: r.input,
    rule: r.rule ? { text: r.rule.text, order: r.rule.order } : undefined,
    precedents: r.precedents.map(p => ({ text: p.text, value: plain(p.value), rowsMatched: p.rowsMatched })),
    otherRules: r.otherRules, referencedBy: r.referencedBy, row: r.row, error: r.error,
    counters: { cellsEvaluated: f.evaluator.counters.cellsEvaluated - before.cellsEvaluated, rowsScanned: f.evaluator.counters.rowsScanned - before.rowsScanned },
  };
}

// ---------- help prompt ----------

export const HELP = `# FiniDB — how to build a model (doc 08 §4)

Use FiniDB for line items × periods with formulas: forecasts, budgets, plans, financial statements,
ledgers rolled into a live plan, anything a human will open and adjust. Not for one-off arithmetic,
data cleaning/joins (Pandas, DuckDB), ad-hoc SQL, or static charts.

## Workflow (five calls)
1. finicast_schema                       see what exists (once, not list_tables five times)
2. finicast_load_table  ×N               load data; read the profiles (types, refCandidate)
3. finicast_define_pivot                 line items × periods; distinctOf for derived dims; periods generated
4. finicast_set_rules   (ONE call)       the whole model as a batch
5. finicast_query format=markdown        the deliverable: the table (+ finicast_share URL when hosted)

Rules of thumb: model line items as a dimension with one measure named value; batch rules in one call;
apply the returned fix instead of retrying; prefer a rule over pre-aggregated data (it stays live);
always return the markdown table and the URL; finicast_explain when a number looks wrong.

## Syntax in one screen
  target[condition] = expression                one rule per line; last matching rule wins; inputs beat rules
  revenue[frame=fcst] = PREV(revenue) * (1 + assumptions.growth)
  revenue[frame=hist] = SUM(financials.amount[account=revenue])
  gross_profit        = revenue - cogs           line items are nouns (ids of the line dim)
  opex                = SUM(value[line.category = opex])   attribute mask over the line dim
  total[tranche=total]= SUM(value[tranche != total])       member mask
  points              = SUM(activities.score)    a table column is a set; SUM groups it by this pivot's dims
  points              = SUM(activities.score[rep.territory=@territory])   explicit group key; @dim = current member
  sum_of_subs         = SUM(goal[region.parent = @region])
  topdown             = topdown[region=@region.parent] * region.pct_of_parent
  balance             = balance[row-1] + amount  tabular running total
  score               = activity_type.points     tabular: follow a ref with a dot
  Selectors: [period-1] [period=first] [period=first..this] [line in (a, b)] [period.year >= 2027]
  Time sugar (needs timeDim): PREV NEXT FIRST LAST CUMSUM TRAILING(x, n, AVG)
  Functions: IF AND OR NOT IFERROR ISBLANK COALESCE ABS ROUND MOD POWER SQRT SUM AVG COUNT COUNTD MIN MAX
             CONCAT LEFT RIGHT LEN LOWER UPPER SUBSTITUTE & (concat)  DATE YEAR MONTH EOMONTH DATEDIF PERIOD(date, periods)
             PMT PV FV NPV IRR  BLANK TRUE FALSE  // comments

## Recipe index (skill/reference/recipes.md)
1. Income statement with hist/fcst frames      5. Territory scoring and quota
2. Ledger → budget (actuals + driver plan)      6. Tiered commission calculator
3. Headcount plan with hire dates and ramp      7. Period tables (month/quarter/year, histUntil)
4. Cohort retention
Errors: skill/reference/errors.md — every code, meaning, fix.`;
