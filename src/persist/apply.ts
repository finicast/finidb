/**
 * Applying a recorded operation to a model.
 *
 * The oplog is a list of facade calls, in order, by user-visible ids; re-applying them is how a database
 * recovers at startup and how a client that holds a model catches up with the changes it missed. Nothing
 * here touches a filesystem: a caller with blobs on disk passes a reader for them, and one without — a
 * browser tab, given the rows inline — does not.
 */
import type { FiniDB } from '../core.js';
import type { FieldSpec, PeriodsSpec } from '../core.js';
import type { Table } from '../schema/schema.js';
import type { Scalar } from '../store/column.js';

/** One recorded mutation: the facade call, its arguments by id, and who made it. */
export interface OpRecord {
  seq: number; ts: string; op: string; args: Record<string, unknown>;
  /** who made the change, when the caller said: an id and, when it has one, a readable name */
  by?: string; byName?: string;
}

/** How to read the rows of a bulk load that was written out of line. */
export type BlobReader = (id: string) => Record<string, Scalar>[];

/** Apply one record. Throws if the op is unknown, which is a client too old for the model it is reading. */
export function applyRecord(f: FiniDB, rec: OpRecord, blob?: BlobReader) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = rec.args as any;
  const table = (): Table => f.model(a.model).table(a.table) as Table;
  const rowsOf = (): Record<string, Scalar>[] => {
    if (!a.blob) return a.rows;
    if (!blob) throw new Error(`OPLOG_BLOB_UNAVAILABLE: ${rec.op} (seq ${rec.seq}) keeps its rows out of line`);
    return blob(a.blob);
  };
  switch (rec.op) {
    case 'createModel': f.createModel(a.id, a.name); break;
    case 'setIterate': f.setIterate(a.model, a.iterate); break;
    case 'createTable': f.createTable(a.model, a.id, a.fields as FieldSpec[], { name: a.name, rows: a.rows, track: a.track === true }); break;
    case 'trackTable': f.trackTable(table()); break;
    case 'addField': f.addField(table(), a.field as FieldSpec); break;
    case 'insertRows': f.insertRows(table(), rowsOf()); break;
    case 'upsertRows': f.upsertRows(table(), rowsOf()); break;
    case 'createDistinctTable': f.createDistinctTable(a.model, a.id, a.sourceTable, a.sourceField); break;
    case 'createPeriods': f.createPeriods(a.model, a.id, a.spec as PeriodsSpec); break;
    case 'createPivot': f.createPivot(a.model, a.id, a.spec); break;
    case 'setRules': f.setRules(a.model, a.table, a.rules, a.opts); break;
    case 'setValue': if (a.measure !== undefined) f.setValue(a.model, a.table, a.at, a.measure, a.value); else f.setValue(a.model, a.table, a.at, a.value); break;
    case 'setCell': f.setCell(a.model, a.table, a.rowId, a.field, a.value); break;
    case 'setSource': f.setSource(a.model, a.table, a.source ?? null); break;
    case 'deleteRows': f.deleteRows(a.model, a.table, a.ids); break;
    case 'dropField': f.dropField(a.model, a.table, a.field); break;
    case 'dropTable': f.dropTable(a.model, a.table); break;
    case 'dropModel': f.dropModel(a.model); break;
    default: throw new Error(`OPLOG_UNKNOWN_OP: ${rec.op} (seq ${rec.seq})`);
  }
}

/**
 * Apply records in order, each under the actor and the clock it was made with, so a tracked table's stamps
 * come back as they were rather than as now. Returns the last seq applied.
 */
export function applyRecords(f: FiniDB, recs: Iterable<OpRecord>, opts: { afterSeq?: number; blob?: BlobReader } = {}): number {
  let last = opts.afterSeq ?? 0;
  const actor = f.actor, nowMs = f.nowMs;
  try {
    for (const rec of recs) {
      if (rec.seq <= last) continue;
      f.actor = rec.by ? { id: rec.by, name: rec.byName } : undefined;
      const t = Date.parse(rec.ts);
      f.nowMs = Number.isFinite(t) ? t : undefined;
      applyRecord(f, rec, opts.blob);
      last = rec.seq;
    }
  } finally {
    f.actor = actor; f.nowMs = nowMs;
  }
  return last;
}
