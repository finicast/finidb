/**
 * Oplog persistence (doc 07 §4.1): an append-only `<dir>/oplog.jsonl`, one JSON object per
 * mutating facade call, `{seq, ts, op, args}`. Bulk row loads are not inlined: batches above
 * `blobThreshold` rows go to a content-addressed `<dir>/blobs/<sha256>.json` and the op
 * references the blob. `replay()` re-applies the log through the same facade methods.
 *
 * Args use the user-visible ids (model id, table id, field id) rather than internal iids: the
 * facade resolves those, and it makes the log readable and portable (§4.1, "export format").
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FiniDB } from '../index.js';
import type { FieldSpec, PeriodsSpec } from '../index.js';
import type { Table } from '../schema/schema.js';
import type { Scalar } from '../store/column.js';
import { applyRecord, type OpRecord } from './apply.js';

export type FsyncPolicy = 'always' | 'interval' | 'never';

export interface OplogOptions {
  /** `always`: fsync after every append. `interval` (default): fsync at most every `intervalMs`. `never`: rely on the OS. */
  fsync?: FsyncPolicy;
  /** fsync period for the `interval` policy (default 100 ms, doc 07 §4.1). */
  intervalMs?: number;
  /** Row batches larger than this are written as blobs (default 1000). */
  blobThreshold?: number;
  /** Floor for the next sequence number (e.g. the seq of a snapshot loaded before the log was opened). */
  seq?: number;
}

export type { OpRecord } from './apply.js';

export const OPLOG_FILE = 'oplog.jsonl';
export const BLOB_DIR = 'blobs';

/** The append-only writer. Lines are written synchronously; the fsync policy only governs durability. */
export class OpLog {
  readonly file: string;
  private fd: number | null;
  private seqCounter: number;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private readonly policy: FsyncPolicy;
  readonly blobThreshold: number;
  /** >0 while a facade call is being replayed or nested inside another recorded call. */
  depth = 0;

  constructor(readonly dir: string, opts: OplogOptions = {}) {
    fs.mkdirSync(path.join(dir, BLOB_DIR), { recursive: true });
    this.file = path.join(dir, OPLOG_FILE);
    this.policy = opts.fsync ?? 'interval';
    this.blobThreshold = opts.blobThreshold ?? 1000;
    const last = readOplog(dir, { repair: true }).at(-1)?.seq ?? 0;
    this.seqCounter = Math.max(last, opts.seq ?? 0);
    this.fd = fs.openSync(this.file, 'a');
    if (this.policy === 'interval') {
      this.timer = setInterval(() => this.sync(), opts.intervalMs ?? 100);
      this.timer.unref();
    }
  }

  /** Last sequence number written (or the floor given at open). */
  get seq(): number { return this.seqCounter; }
  get closed(): boolean { return this.fd === null; }

  /** Append one op. Returns the record with its assigned seq. */
  append(op: string, args: Record<string, unknown>, by?: { id: string; name?: string }): OpRecord {
    if (this.fd === null) throw new Error('OPLOG_CLOSED');
    const rec: OpRecord = { seq: ++this.seqCounter, ts: new Date().toISOString(), op, args, ...(by?.id ? { by: by.id, ...(by.name ? { byName: by.name } : {}) } : {}) };
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    this.dirty = true;
    if (this.policy === 'always') this.sync();
    return rec;
  }

  /** Write a content-addressed blob; returns its sha256 hex id. Idempotent. */
  writeBlob(content: string): string {
    const id = createHash('sha256').update(content).digest('hex');
    const file = path.join(this.dir, BLOB_DIR, `${id}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file + '.tmp', content);
      if (this.policy !== 'never') { const bfd = fs.openSync(file + '.tmp', 'r+'); try { fs.fsyncSync(bfd); } finally { fs.closeSync(bfd); } }
      fs.renameSync(file + '.tmp', file);
    }
    return id;
  }

  /** fsync if anything was written since the last sync. */
  sync() {
    if (this.fd === null || !this.dirty) return;
    fs.fsyncSync(this.fd);
    this.dirty = false;
  }

  /** Run `fn` without recording (used by replay and by nested facade calls). */
  silently<T>(fn: () => T): T {
    this.depth++;
    try { return fn(); } finally { this.depth--; }
  }

  /** Flush, fsync and close the file. Safe to call twice. */
  close() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.fd === null) return;
    if (this.policy !== 'never') this.sync();
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * Read every record of `<dir>/oplog.jsonl`. A torn final line (crash mid-write) is dropped, and
 * with `repair` the file is truncated back to the last complete line.
 */
export function readOplog(dir: string, opts: { repair?: boolean } = {}): OpRecord[] {
  const file = path.join(dir, OPLOG_FILE);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out: OpRecord[] = [];
  let good = 0; // byte offset after the last complete record
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break; // no trailing newline: torn write
    const line = text.slice(pos, nl).trim();
    if (line) {
      try { out.push(JSON.parse(line) as OpRecord); }
      catch { break; }
    }
    pos = nl + 1;
    good = pos;
  }
  if (good < text.length && opts.repair) fs.truncateSync(file, Buffer.byteLength(text.slice(0, good)));
  return out;
}

const logs = new WeakMap<FiniDB, OpLog>();
/** The oplog attached to `f` by `withOplog`, if any. */
export function oplogOf(f: FiniDB): OpLog | undefined { return logs.get(f); }

export type PersistentDB<F extends FiniDB = FiniDB> = F & { readonly oplog: OpLog };

/**
 * Attach an oplog to a FiniDB instance: every mutating facade method is wrapped so that a
 * successful call appends one record. Nested facade calls (createTable -> addField/insertRows)
 * are not recorded twice; createTable with rows is logged as `createTable` + `insertRows` so
 * that the blob rule applies uniformly.
 *
 * A call that throws is NOT logged. Facade methods that mutate before validating (a bad ref in
 * row 500 of a batch, a rule that fails the smoke test) can leave memory ahead of the log.
 */
export function withOplog<F extends FiniDB>(f: F, dir: string, opts: OplogOptions = {}): PersistentDB<F> {
  if (logs.has(f)) throw new Error('OPLOG_ALREADY_ATTACHED');
  const log = new OpLog(dir, opts);
  logs.set(f, log);
  Object.defineProperty(f, 'oplog', { value: log, enumerable: false });

  const orig = {
    createModel: f.createModel, createTable: f.createTable, addField: f.addField, insertRows: f.insertRows,
    createDistinctTable: f.createDistinctTable, createPeriods: f.createPeriods, createPivot: f.createPivot,
    setRules: f.setRules, setValue: f.setValue, setCell: f.setCell,
    upsertRows: f.upsertRows, setSource: f.setSource, trackTable: f.trackTable, deleteRows: f.deleteRows, dropField: f.dropField, dropTable: f.dropTable, dropModel: f.dropModel, addFieldTo: f.addFieldTo,
    setIterate: f.setIterate,
  };
  // Run `call` under the recording guard and, if it is the outermost call, log `args`.
  const record = <T>(op: string, call: () => T, args: () => Record<string, unknown>): T => {
    if (log.depth > 0) return call();
    const r = log.silently(call);
    log.append(op, args(), f.actor);
    return r;
  };

  f.createModel = (id, name) => record('createModel', () => orig.createModel.call(f, id, name), () => ({ id, name }));
  f.setIterate = (modelId, iterate) => record('setIterate', () => orig.setIterate.call(f, modelId, iterate), () => ({ model: modelId, iterate: f.model(modelId).iterate ?? null }));
  f.createTable = (modelId, id, fields, o = {}) => {
    const t = record('createTable', () => orig.createTable.call(f, modelId, id, fields, { name: o.name, track: o.track }), () => ({ model: modelId, id, fields, name: o.name, ...(o.track ? { track: true } : {}) }));
    if (o.rows && log.depth === 0) f.insertRows(t, o.rows);
    else if (o.rows) orig.insertRows.call(f, t, o.rows);
    return t;
  };
  f.trackTable = t => record('trackTable', () => orig.trackTable.call(f, t), () => ({ model: t.model.id, table: t.id }));
  f.addField = (t, spec) => record('addField', () => orig.addField.call(f, t, spec), () => ({ model: t.model.id, table: t.id, field: spec }));
  f.insertRows = (t, rows) => record('insertRows', () => orig.insertRows.call(f, t, rows), () => {
    const base = { model: t.model.id, table: t.id };
    if (rows.length <= log.blobThreshold) return { ...base, rows };
    return { ...base, blob: log.writeBlob(JSON.stringify(rows)), count: rows.length };
  });
  f.upsertRows = (t, rows) => record('upsertRows', () => orig.upsertRows.call(f, t, rows), () => {
    const base = { model: t.model.id, table: t.id };
    if (rows.length <= log.blobThreshold) return { ...base, rows };
    return { ...base, blob: log.writeBlob(JSON.stringify(rows)), count: rows.length };
  });
  f.createDistinctTable = (modelId, id, sourceTable, sourceField) =>
    record('createDistinctTable', () => orig.createDistinctTable.call(f, modelId, id, sourceTable, sourceField), () => ({ model: modelId, id, sourceTable, sourceField }));
  f.createPeriods = (modelId, id, spec) => record('createPeriods', () => orig.createPeriods.call(f, modelId, id, spec), () => ({ model: modelId, id, spec }));
  f.createPivot = (modelId, id, spec) => record('createPivot', () => orig.createPivot.call(f, modelId, id, spec), () => ({ model: modelId, id, spec }));
  f.setRules = (modelId, tableId, rules, o) => record('setRules', () => orig.setRules.call(f, modelId, tableId, rules, o), () => ({ model: modelId, table: tableId, rules, opts: o }));
  f.setValue = (modelId, tableId, at, measureOrValue, value) =>
    record('setValue', () => orig.setValue.call(f, modelId, tableId, at, measureOrValue, value), () =>
      value === undefined ? { model: modelId, table: tableId, at, value: measureOrValue } : { model: modelId, table: tableId, at, measure: String(measureOrValue), value });
  f.setCell = (modelId, tableId, rowId, fieldId, value) =>
    record('setCell', () => orig.setCell.call(f, modelId, tableId, rowId, fieldId, value), () => ({ model: modelId, table: tableId, rowId, field: fieldId, value }));

  f.setSource = (modelId, tableId, source) => record('setSource', () => orig.setSource.call(f, modelId, tableId, source), () => ({ model: modelId, table: tableId, source }));
  f.deleteRows = (modelId, tableId, ids) => record('deleteRows', () => orig.deleteRows.call(f, modelId, tableId, ids), () => ({ model: modelId, table: tableId, ids }));
  f.dropField = (modelId, tableId, fieldId) => record('dropField', () => orig.dropField.call(f, modelId, tableId, fieldId), () => ({ model: modelId, table: tableId, field: fieldId }));
  f.dropTable = (modelId, tableId) => record('dropTable', () => orig.dropTable.call(f, modelId, tableId), () => ({ model: modelId, table: tableId }));
  f.dropModel = (modelId) => record('dropModel', () => orig.dropModel.call(f, modelId), () => ({ model: modelId }));
  f.addFieldTo = (modelId, tableId, spec) => record('addField', () => orig.addFieldTo.call(f, modelId, tableId, spec), () => ({ model: modelId, table: tableId, field: spec }));

  return f as PersistentDB<F>;
}

/**
 * A FiniDB that records to `<dir>/oplog.jsonl` from construction. Call `oplog.close()` when done.
 * (A factory rather than a subclass: `index.ts` re-exports this module, so `FiniDB` is not yet
 * initialised while this module evaluates.)
 */
export function createPersistentFiniDB(dir: string, opts: OplogOptions & { engine?: 'incremental' | 'reference' } = {}): PersistentDB {
  return withOplog(new FiniDB({ engine: opts.engine }), dir, opts);
}

/** Apply one record to `f` (without recording it again if `f` has an oplog attached). */
export function applyOp(f: FiniDB, rec: OpRecord, dir: string) {
  const log = logs.get(f);
  const run = () => applyOpRaw(f, rec, dir);
  if (log) log.silently(run); else run();
}

function applyOpRaw(f: FiniDB, rec: OpRecord, dir: string) {
  applyRecord(f, rec, id => JSON.parse(fs.readFileSync(path.join(dir, BLOB_DIR, `${id}.json`), 'utf8')));
}

/**
 * Re-apply `<dir>/oplog.jsonl` to `f` in order, skipping records with `seq <= afterSeq`
 * (the part already covered by a snapshot). Returns the last seq applied (or `afterSeq`).
 */
export function replay(f: FiniDB, dir: string, opts: { afterSeq?: number } = {}): number {
  let last = opts.afterSeq ?? 0;
  const actor = f.actor, nowMs = f.nowMs;
  try {
    for (const rec of readOplog(dir)) {
      if (rec.seq <= last) continue;
      // Replay under the record's own actor and clock, so a tracked table's stamps come back as they were.
      f.actor = rec.by ? { id: rec.by, name: rec.byName } : undefined;
      const t = Date.parse(rec.ts);
      f.nowMs = Number.isFinite(t) ? t : undefined;
      applyOp(f, rec, dir);
      last = rec.seq;
    }
  } finally { f.actor = actor; f.nowMs = nowMs; }
  return last;
}
