/**
 * What a model looks like: tables, fields, dims, measures and rules, as `/describe` reports them. The shape a
 * card dialog and an agent read, built from the schema alone, so a tab holding the model can answer it too.
 */
import type { AnyTable } from '../schema/schema.js';
import { TRACK_FIELDS } from '../core.js';

export function describeRules(t: AnyTable) {
  return t.rules.map(r => ({ order: r.order, target: r.target, when: r.when, formula: r.formula, name: r.name, status: r.status, error: r.error }));
}
export function describeTable(t: AnyTable) {
  if (t.kind === 'tabular') return {
    id: t.id, name: t.name, kind: 'tabular' as const, model: t.model.id, rowCount: t.rowCount, version: t.version,
    fields: t.fields.map(fl => ({ id: fl.id, name: fl.name, type: fl.type, ref: fl.refTable?.id, computed: fl.computed, format: fl.format, ...(t.track && TRACK_FIELDS.some(k => k.id === fl.id) ? { managed: true } : {}) })),
    track: t.track || undefined,
    distinctOf: t.distinctOf ? { table: t.distinctOf.table.id, field: t.distinctOf.field.id } : undefined,
    source: t.source,
    rules: describeRules(t),
  };
  return {
    id: t.id, name: t.name, kind: 'pivot' as const, model: t.model.id, cells: t.totalCells(), version: t.version,
    dims: t.dims.map(d => ({ id: d.id, name: d.name, table: d.table.id, memberCount: d.table.rowCount, members: d.table.rowCount <= 2000 ? Array.from({ length: d.table.rowCount }, (_, i) => d.table.rowId(i)) : undefined, memberNames: d.table.rowCount <= 2000 && d.table.hasField('name') ? Array.from({ length: d.table.rowCount }, (_, i) => { const n = d.table.field('name').column.get(i); return n === null || n === '' ? d.table.rowId(i) : String(n); }) : undefined, attributes: d.table.fields.filter(f => f.id !== 'id').map(f => f.id) })),
    measures: t.measures.map(m => ({ id: m.id, name: m.name, type: m.type, format: m.format })),
    lineDim: t.lineDim?.id, timeDim: t.timeDim?.id,
    rules: describeRules(t),
  };
}
