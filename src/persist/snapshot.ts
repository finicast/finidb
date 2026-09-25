/**
 * Snapshots on disk: the format itself lives in `snapshot-codec.ts`, which knows nothing of files, so the
 * same encoder and decoder run on a server, on a worker thread and in a browser tab. This module is the
 * filesystem around it.
 */
import * as fs from 'node:fs';
import type { FiniDB } from '../index.js';
import { encodeSnapshot, decodeSnapshot, readSnapshotBytes, type SnapshotHeader } from './snapshot-codec.js';

export * from './snapshot-codec.js';

/** Serialize `f` (inputs only) to `path`, atomically via a temp file. Returns the bytes written. */
export function saveSnapshot(f: FiniDB, path: string, opts: { seq?: number } = {}): Buffer {
  const bytes = Buffer.from(encodeSnapshot(f, opts));
  if (!path) return bytes;
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, bytes);
  const fd = fs.openSync(tmp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
  return bytes;
}

/** The same bytes, handed back instead of written: what a worker thread or a browser is given. */
export function snapshotBuffer(f: FiniDB, opts: { seq?: number } = {}): Buffer { return saveSnapshot(f, '', opts); }

/** Parse the container of a snapshot file, or of bytes already in hand. */
export function readSnapshotHeader(path: string | Uint8Array): { header: SnapshotHeader; payload: Uint8Array } {
  return readSnapshotBytes(typeof path === 'string' ? fs.readFileSync(path) : path);
}

/** Rebuild a working FiniDB from a snapshot file, or from the bytes of one. */
export function loadSnapshot(path: string | Uint8Array, opts: { engine?: 'incremental' | 'reference' } = {}): FiniDB {
  return decodeSnapshot(typeof path === 'string' ? fs.readFileSync(path) : path, opts);
}
