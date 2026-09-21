/**
 * Before a local build: fetch every linked table of a document that has no rows yet, so `applyDocument`
 * (synchronous) can create it with data. The source is kept on the table with its fetch stamp.
 */
import type { ModelDocument } from '../build/document.js';
import { fetchSource, envSecrets, type FetchOptions } from './fetch.js';
import { SourceError } from './types.js';

export interface PrefetchResult { fetched: string[]; failed: { table: string; code: string; message: string; fix?: string }[] }

export async function prefetchSources(doc: ModelDocument, opts: FetchOptions & { strict?: boolean } = {}): Promise<PrefetchResult> {
  const out: PrefetchResult = { fetched: [], failed: [] };
  const secrets = { ...envSecrets(), ...(opts.secrets ?? {}) };
  for (const [id, t] of Object.entries(doc.tables ?? {})) {
    if (!t.source || t.rows || t.csv) continue;
    try {
      const r = await fetchSource(t.source, { ...opts, secrets });
      t.rows = r.rows;
      t.source = { ...t.source, fetchedAt: new Date().toISOString(), status: 'ok', fetchedRows: r.rows.length };
      out.fetched.push(id);
    } catch (e) {
      const err = e instanceof SourceError ? { code: e.code, message: e.message, fix: e.fix } : { code: 'SOURCE_FAILED', message: e instanceof Error ? e.message : String(e) };
      if (opts.strict) throw e;
      t.rows = [];
      t.source = { ...t.source, status: 'error', error: `${err.code}: ${err.message}` };
      out.failed.push({ table: id, ...err });
    }
  }
  return out;
}
