/**
 * The worker side of an off-thread job: it is handed the bytes of a snapshot, loads the model, does the work
 * and sends the result back. It shares nothing with the server's own databases, so whatever it does — a
 * workbook that takes four minutes, a query over a hundred thousand rows — leaves every other request alone.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadSnapshot } from '../persist/snapshot.js';
import { exportWorkbook, type ExportOptions } from '../export/workbook.js';

export interface JobRequest {
  snapshot: ArrayBuffer;
  kind: 'exportXlsx';
  model: string;
  opts: ExportOptions;
}
export interface JobReply { ok: true; bytes: ArrayBuffer; meta: Record<string, unknown> } 

const job = workerData as JobRequest;
try {
  const f = loadSnapshot(Buffer.from(job.snapshot));
  if (job.kind !== 'exportXlsx') throw new Error(`WORKER_UNKNOWN_JOB: ${job.kind}`);
  const r = exportWorkbook(f.db, job.model, job.opts);
  const copy = new Uint8Array(r.buffer.byteLength);   // a copy the worker can hand over, not a view into its heap
  copy.set(r.buffer);
  const reply: JobReply = { ok: true, bytes: copy.buffer, meta: { formulas: r.formulas, values: r.values, sheets: r.sheets, notes: r.notes } };
  parentPort!.postMessage(reply, [copy.buffer]);
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
