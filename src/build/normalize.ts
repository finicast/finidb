/**
 * Shape-check a model document before it is applied, with the JSON path in every message, and
 * forgive the slips agents make: a list written as an object of keys (`"rows": { "company": "*" }`),
 * a single string where a list is expected, rules as an array. What cannot be forgiven becomes a
 * DocumentError (code BAD_DOCUMENT) instead of a TypeError from deep inside the builder.
 */
export class DocumentError extends Error {
  constructor(message: string, public path: string, public fix?: string) { super(message); this.name = 'DocumentError'; }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(path: string, message: string, fix?: string): never { throw new DocumentError(`${path}: ${message}`, path, fix); }
/** Assign only when there is a value: an absent key stays absent, so a document that needs no coercion is returned unchanged. */
function set(obj: Record<string, unknown>, key: string, val: unknown): void { if (val !== undefined) obj[key] = val; }

/** A list of ids: an array of strings, a single string, or an object whose keys are the ids ("*" values are dropped). */
function toList(v: unknown, path: string, notes: string[], what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    if (!v.every(x => typeof x === 'string' || typeof x === 'number')) fail(path, `must be an array of ${what}`, `e.g. ["revenue", "ebitda"]`);
    return v.every(x => typeof x === 'string') ? (v as string[]) : v.map(String);
  }
  if (typeof v === 'string') return [v];
  if (isObj(v)) { const keys = Object.keys(v); notes.push(`${path}: read the object's keys as the list (${keys.join(', ')})`); return keys; }
  return fail(path, `must be an array of ${what}`, `e.g. ["revenue", "ebitda"]`);
}
function toFilters(v: unknown, path: string, notes: string[]): Record<string, string[]> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) return fail(path, 'must be an object of dimension → list of members', 'e.g. { "line": ["revenue", "ebitda"] }');
  const out: Record<string, string[]> = {};
  let changed = false;
  for (const [k, x] of Object.entries(v)) { const l = toList(x, `${path}.${k}`, notes, 'member ids') ?? []; if (l !== x) changed = true; out[k] = l; }
  return changed ? out : (v as Record<string, string[]>);
}
function toRules(v: unknown, path: string): string | string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.every(r => typeof r === 'string')) return v as string[];
    return v.map((r, i) => {
      if (typeof r === 'string') return r;
      if (isObj(r) && typeof r.target === 'string' && typeof r.formula === 'string') return `${r.target}${r.when ? `[${String(r.when)}]` : ''} = ${r.formula}`;
      return fail(`${path}[${i}]`, 'must be a rule string like "gross_profit = revenue - cogs"');
    });
  }
  return fail(path, 'must be a string (one rule per line) or an array of rule strings');
}

/** Returns the same document, coerced in place where a slip is unambiguous; throws DocumentError otherwise. */
export function normalizeDocument<T extends Record<string, unknown>>(doc: T): { doc: T; notes: string[] } {
  const notes: string[] = [];
  if (!isObj(doc)) fail('document', 'must be a JSON object with periods, tables, pivots, outputs and dashboards');
  const d = doc as Record<string, unknown>;
  if (d.periods !== undefined) {
    if (!isObj(d.periods)) fail('periods', 'must be an object', 'e.g. { "start": "2024-01", "count": 5, "grain": "year", "histUntil": "2025-12-31" }');
    const p = d.periods as Record<string, unknown>;
    if (typeof p.start !== 'string' || typeof p.count !== 'number' || !['month', 'quarter', 'year'].includes(String(p.grain))) fail('periods', 'needs start (YYYY-MM), count (a number) and grain (month | quarter | year)');
  }
  if (d.tables !== undefined) {
    if (!isObj(d.tables)) fail('tables', 'must be an object keyed by table id');
    for (const [id, tv] of Object.entries(d.tables as Record<string, unknown>)) {
      if (!isObj(tv)) fail(`tables.${id}`, 'must be an object', 'e.g. { "rows": [{ "id": "a", "name": "A" }] }');
      const t = tv as Record<string, unknown>;
      if (t.rows !== undefined && (!Array.isArray(t.rows) || !t.rows.every(isObj))) fail(`tables.${id}.rows`, 'must be an array of row objects', 'e.g. [{ "id": "nvda", "name": "NVIDIA", "peer": 1 }]');
      if (t.fields !== undefined && !isObj(t.fields) && !Array.isArray(t.fields)) fail(`tables.${id}.fields`, 'must be an object { field: type } or an array of { id, type }');
      if (t.csv !== undefined && typeof t.csv !== 'string') fail(`tables.${id}.csv`, 'must be CSV text with a header row');
      if (t.rules !== undefined) set(t, 'rules', toRules(t.rules, `tables.${id}.rules`));
    }
  }
  if (d.pivots !== undefined) {
    if (!isObj(d.pivots)) fail('pivots', 'must be an object keyed by pivot id');
    for (const [id, pv] of Object.entries(d.pivots as Record<string, unknown>)) {
      if (!isObj(pv)) fail(`pivots.${id}`, 'must be an object with lines, dims, inputs, rules');
      const p = pv as Record<string, unknown>;
      if (p.lines !== undefined) {
        if (!Array.isArray(p.lines)) fail(`pivots.${id}.lines`, 'must be an array of line ids or { id, name, format } objects');
        (p.lines as unknown[]).forEach((l, i) => { if (!(typeof l === 'string' || (isObj(l) && typeof l.id === 'string'))) fail(`pivots.${id}.lines[${i}]`, 'must be a string id or { "id", "name", "format" }'); });
      }
      if (p.dims !== undefined) {
        if (!isObj(p.dims)) fail(`pivots.${id}.dims`, 'must be an object dimension → table id', 'e.g. { "company": "companies", "period": false }');
        for (const [k, v] of Object.entries(p.dims as Record<string, unknown>)) if (!(typeof v === 'string' || v === false)) fail(`pivots.${id}.dims.${k}`, 'must be a table id, or false to leave the periods dimension off');
      }
      if (p.inputs !== undefined) {
        if (!isObj(p.inputs)) fail(`pivots.${id}.inputs`, 'must be an object line → { member: value }', 'e.g. { "revenue": { "fy2024": 1915 } }');
        for (const [line, by] of Object.entries(p.inputs as Record<string, unknown>)) if (!isObj(by)) fail(`pivots.${id}.inputs.${line}`, 'must be an object member → value', 'e.g. { "fy2024": 1915, "fy2025": 5131 }');
      }
      if (p.values !== undefined) {
        if (!Array.isArray(p.values)) fail(`pivots.${id}.values`, 'must be an array of { "at": { dim: member }, "value": number }');
        (p.values as unknown[]).forEach((v, i) => { if (!isObj(v) || !isObj(v.at)) fail(`pivots.${id}.values[${i}]`, 'must be { "at": { dim: member, … }, "value": number }'); });
      }
      if (p.rules !== undefined) set(p, 'rules', toRules(p.rules, `pivots.${id}.rules`));
      if (p.measures !== undefined && !Array.isArray(p.measures)) fail(`pivots.${id}.measures`, 'must be an array of measure ids or { id, type, format } objects');
    }
  }
  if (d.outputs !== undefined && d.outputs !== 'all') {
    if (!Array.isArray(d.outputs)) fail('outputs', 'must be "all" or an array of { pivot, title, rows, cols, lines }');
    (d.outputs as unknown[]).forEach((ov, i) => {
      if (!isObj(ov) || typeof ov.pivot !== 'string') fail(`outputs[${i}]`, 'must be an object with a pivot id', 'e.g. { "pivot": "income_statement" }');
      const o = ov as Record<string, unknown>;
      set(o, 'rows', toList(o.rows, `outputs[${i}].rows`, notes, 'dimension ids'));
      set(o, 'cols', toList(o.cols, `outputs[${i}].cols`, notes, 'dimension ids'));
      set(o, 'lines', toList(o.lines, `outputs[${i}].lines`, notes, 'line ids'));
      set(o, 'filters', toFilters(o.filters, `outputs[${i}].filters`, notes));
      if (o.pages !== undefined && !isObj(o.pages)) fail(`outputs[${i}].pages`, 'must be an object dimension → member');
    });
  }
  if (d.dashboards !== undefined && d.dashboards !== 'auto') {
    if (!Array.isArray(d.dashboards)) fail('dashboards', 'must be "auto" or an array of { id, name, theme, cards }');
    (d.dashboards as unknown[]).forEach((dv, i) => {
      if (!isObj(dv)) fail(`dashboards[${i}]`, 'must be an object with cards');
      const db = dv as Record<string, unknown>;
      if (db.cards !== undefined && !Array.isArray(db.cards)) fail(`dashboards[${i}].cards`, 'must be an array of cards', 'e.g. [{ "kind": "table", "pivot": "comps" }]');
      if (db.params !== undefined) {
        if (typeof db.params === 'string') db.params = [db.params];
        if (!Array.isArray(db.params) || !(db.params as unknown[]).every(x => typeof x === 'string' || (isObj(x) && typeof x.id === 'string'))) fail(`dashboards[${i}].params`, 'must be an array of parameter ids or { "id", "label", "default" } objects', 'e.g. ["account", "period"]');
      }
      (db.cards as unknown[] | undefined)?.forEach((cv, j) => {
        const path = `dashboards[${i}].cards[${j}]`;
        if (!isObj(cv)) fail(path, 'must be an object', 'e.g. { "kind": "chart", "type": "line", "pivot": "income_statement", "lines": ["revenue"] }');
        const c = cv as Record<string, unknown>;
        if (c.kind === 'data') { if (typeof c.table !== 'string' || !c.table) fail(`${path}.table`, 'a data card names the data table it shows', 'e.g. { "kind": "data", "table": "ledger", "where": { "account": "$account" } }'); }
        else if (c.kind === 'distribution') {
          if (typeof c.table !== 'string' || !c.table) fail(`${path}.table`, 'a distribution card names the data table its observations come from', 'e.g. { "kind": "distribution", "table": "opps", "field": "acv", "bins": 12 }');
          if (typeof c.field !== 'string' || !c.field) fail(`${path}.field`, 'a distribution card names the numeric field it bins', 'e.g. "field": "acv"');
          if (typeof c.bins === 'string' && /^\d+$/.test(c.bins)) c.bins = Number(c.bins);
          if (c.bins !== undefined && !(typeof c.bins === 'number' && c.bins >= 2) && !['quartiles', 'quintiles', 'deciles'].includes(c.bins as string)) fail(`${path}.bins`, 'is a number of value ranges (2 or more) or "quartiles" | "quintiles" | "deciles"');
          if (c.y !== undefined && !['count', 'sum', 'mean'].includes(c.y as string)) fail(`${path}.y`, 'is "count" (observations per bin), "sum" or "mean" of the field');
          if (c.marks !== undefined && !['quartiles', 'quintiles', 'deciles'].includes(c.marks as string)) fail(`${path}.marks`, 'is "quartiles" | "quintiles" | "deciles"');
          if (c.tail !== undefined && c.tail !== 'fold' && c.tail !== 'keep') fail(`${path}.tail`, 'is "fold" (default: bin to the 99th percentile, the rest in a final bar) or "keep"');
        }
        else if (c.kind === 'text') { if (c.text !== undefined && typeof c.text !== 'string') fail(`${path}.text`, 'a text card carries markdown as a string'); }
        else if (c.kind !== 'links' && typeof c.pivot !== 'string') fail(`${path}.pivot`, 'names the pivot the card shows');
        if (c.drill !== undefined) { if (!isObj(c.drill) || typeof (c.drill as Record<string, unknown>).dashboard !== 'string') fail(`${path}.drill`, 'must be { "dashboard": "<id>", "params": { param: "$row" } }'); }
        set(c, 'fields', toList(c.fields, `${path}.fields`, notes, 'field ids'));
        set(c, 'rows', toList(c.rows, `${path}.rows`, notes, 'dimension ids'));
        set(c, 'cols', toList(c.cols, `${path}.cols`, notes, 'dimension ids'));
        set(c, 'lines', toList(c.lines, `${path}.lines`, notes, 'line ids'));
        set(c, 'periods', toList(c.periods, `${path}.periods`, notes, 'period ids'));
        set(c, 'dashboards', toList(c.dashboards, `${path}.dashboards`, notes, 'dashboard ids'));
        set(c, 'filters', toFilters(c.filters, `${path}.filters`, notes));
        if (c.pages !== undefined && !isObj(c.pages)) fail(`${path}.pages`, 'must be an object dimension → member');
      });
    });
  }
  return { doc, notes };
}
