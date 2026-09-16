/**
 * Durable database directory (doc 07 §4): recovery = newest snapshot + replay of the oplog tail.
 *
 *   <dir>/oplog.jsonl          append-only op records (§4.1)
 *   <dir>/blobs/<sha256>.json  bulk row batches referenced by the log
 *   <dir>/snapshot-<seq>.fdb   binary input snapshots (§4.2); the log is never truncated
 *   <dir>/meta.json            { snapshotSeq, snapshotFile }
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FiniDB } from '../index.js';
import { withOplog, replay, type OplogOptions, type PersistentDB } from './oplog.js';
import { saveSnapshot, loadSnapshot } from './snapshot.js';

export const META_FILE = 'meta.json';

export interface StoreMeta { snapshotSeq: number; snapshotFile?: string }

export interface OpenOptions extends OplogOptions { engine?: 'incremental' | 'reference' }

export interface OpenedDatabase {
  readonly f: PersistentDB;
  readonly dir: string;
  /** Last oplog seq (grows with every mutating call). */
  readonly seq: number;
  /** Write `snapshot-<seq>.fdb` and point meta.json at it. The log is kept. Returns the file path. */
  snapshot(): Promise<string>;
  /** Flush and fsync the log, then release the file. */
  close(): Promise<void>;
}

export function readMeta(dir: string): StoreMeta {
  const file = path.join(dir, META_FILE);
  if (!fs.existsSync(file)) return { snapshotSeq: 0 };
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StoreMeta;
}

function writeMeta(dir: string, meta: StoreMeta) {
  const file = path.join(dir, META_FILE);
  fs.writeFileSync(file + '.tmp', JSON.stringify(meta, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/** Newest usable snapshot: the one meta.json names, else the highest-seq `snapshot-*.fdb` present. */
function findSnapshot(dir: string, meta: StoreMeta): { file: string; seq: number } | undefined {
  if (meta.snapshotFile && fs.existsSync(path.join(dir, meta.snapshotFile))) return { file: path.join(dir, meta.snapshotFile), seq: meta.snapshotSeq };
  let best: { file: string; seq: number } | undefined;
  for (const name of fs.readdirSync(dir)) {
    const m = /^snapshot-(\d+)\.fdb$/.exec(name);
    if (m && (!best || Number(m[1]) > best.seq)) best = { file: path.join(dir, name), seq: Number(m[1]) };
  }
  return best;
}

/**
 * Open (or create) a database directory. Loads the newest snapshot if any, replays oplog records
 * with `seq > snapshotSeq`, and attaches the oplog so new mutations are appended.
 */
export async function openDatabase(dir: string, opts: OpenOptions = {}): Promise<OpenedDatabase> {
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta(dir);
  const snap = findSnapshot(dir, meta);
  const base: FiniDB = snap ? loadSnapshot(snap.file, { engine: opts.engine }) : new FiniDB({ engine: opts.engine });
  const snapshotSeq = snap?.seq ?? 0;
  replay(base, dir, { afterSeq: snapshotSeq });
  // New ops must sort after the snapshot even if the log was removed: floor the seq at snapshotSeq.
  const f = withOplog(base, dir, { ...opts, seq: Math.max(opts.seq ?? 0, snapshotSeq) });

  return {
    f, dir,
    get seq() { return f.oplog.seq; },
    async snapshot() {
      f.oplog.sync();
      const seq = f.oplog.seq;
      const name = `snapshot-${seq}.fdb`;
      saveSnapshot(f, path.join(dir, name), { seq });
      writeMeta(dir, { snapshotSeq: seq, snapshotFile: name });
      return path.join(dir, name);
    },
    async close() { f.oplog.close(); },
  };
}
