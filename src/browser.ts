/**
 * finidb for a browser: the engine, and nothing that needs a filesystem.
 *
 * A page fetches the bytes of a snapshot, calls `openSnapshot`, and from then on every window, cell and
 * explanation is computed in the tab. The same code the server runs, so the same numbers.
 */
export { FiniDB } from './core.js';
export type { QueryOptions, Grid } from './core.js';
export { columnar, WindowError } from './view/window.js';
export type { ColumnarWindow } from './view/window.js';
export { readRows, RowsError } from './view/rows.js';
export { describeTable, describeRules } from './view/describe.js';
export type { Where } from './view/rows.js';
export { decodeSnapshot, readSnapshotBytes, MAGIC, FORMAT_VERSION } from './persist/snapshot-codec.js';
export type { SnapshotHeader } from './persist/snapshot-codec.js';
export type { Scalar, Value, FieldType } from './store/column.js';
export type { AnyTable, Table, Pivot, Dim, Measure, Model } from './schema/schema.js';

import { decodeSnapshot } from './persist/snapshot-codec.js';
import type { FiniDB } from './core.js';

/** Load a model from the bytes of a snapshot. Accepts what `fetch(...).arrayBuffer()` gives you. */
export function openSnapshot(bytes: ArrayBuffer | Uint8Array, opts: { engine?: 'incremental' | 'reference' } = {}): FiniDB {
  return decodeSnapshot(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), opts);
}
