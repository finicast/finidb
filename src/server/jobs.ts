/**
 * Work that must not block the server (doc 07): a job runs on a worker thread against a snapshot of the
 * database, so the thread that answers every other request stays free. The snapshot is taken on the main
 * thread — serialising columns is fast — and the expensive part happens elsewhere.
 *
 * One job per database at a time: a second request for the same workbook waits for the first rather than
 * doubling the work, which is what an impatient caller (or a crawler) would otherwise cause.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import type { FiniDB } from '../index.js';
import { snapshotBuffer } from '../persist/snapshot.js';
import type { ExportOptions } from '../export/workbook.js';

export interface JobResult { bytes: Buffer; meta: Record<string, unknown> }

const running = new Map<string, Promise<JobResult>>();

/**
 * The worker's own file. Running from `dist` it sits beside this one. Running from `src` (tests, `tsx`) the
 * compiled copy is used when there is one, because a worker does not inherit the loader that made `.ts`
 * importable; failing that, the source is used and the loader is passed along in `execArgv`.
 */
function workerFile(): { file: string; execArgv?: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'worker.js');
  if (existsSync(built)) return { file: built };
  const fromSrc = here.replace(`${sep}src${sep}`, `${sep}dist${sep}`);
  const compiled = join(fromSrc, 'worker.js');
  if (existsSync(compiled)) return { file: compiled };
  return { file: join(here, 'worker.ts'), execArgv: ['--import', 'tsx'] };
}

/** Run a job on a worker. `timeoutMs` and `memoryMb` bound it: a runaway job dies alone. */
export function runJob(key: string, f: FiniDB, job: { kind: 'exportXlsx'; model: string; opts: ExportOptions }, limits: { timeoutMs?: number; memoryMb?: number } = {}): Promise<JobResult> {
  const already = running.get(key);
  if (already) return already;
  const snapshot = snapshotBuffer(f);
  const bytes = new Uint8Array(snapshot.byteLength);
  bytes.set(snapshot);
  const p = new Promise<JobResult>((resolve, reject) => {
    const { file, execArgv } = workerFile();
    const w = new Worker(file, {
      workerData: { snapshot: bytes.buffer, ...job },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb ?? 1536 },
      ...(execArgv ? { execArgv } : {}),
    });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error('JOB_TIMEOUT')); }, limits.timeoutMs ?? 300_000);
    w.on('message', (m: { ok: boolean; bytes?: ArrayBuffer; meta?: Record<string, unknown>; error?: string }) => {
      clearTimeout(timer);
      if (m.ok && m.bytes) resolve({ bytes: Buffer.from(m.bytes), meta: m.meta ?? {} });
      else reject(new Error(m.error ?? 'JOB_FAILED'));
      void w.terminate();
    });
    w.on('error', e => { clearTimeout(timer); reject(e); });
    w.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`JOB_EXIT_${code}`)); });
  }).finally(() => { running.delete(key); });
  running.set(key, p);
  return p;
}
