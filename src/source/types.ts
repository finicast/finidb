/**
 * Linked tables: a data table whose rows come from an HTTP source and are refreshed on demand (doc 09 §7).
 * A source is data, not code: requests with a URL, headers, a JSON path or CSV, a field map and an id
 * template. Secrets never appear in a source; `{{secret:name}}` placeholders are resolved at fetch time
 * from the caller's secrets or the environment. A preset (FMP first) expands a few parameters into requests.
 */
import type { Scalar } from '../store/column.js';

export type Transform = 'number' | 'text' | 'year' | 'date' | 'abs' | 'neg';
/** One mapped field: the source key (dotted path allowed), or a key plus a transform / no scaling. */
export type FieldMap = string | { from: string; transform?: Transform; scale?: false };

export interface SourceRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  format?: 'json' | 'csv';
  /** JSON: dotted path to the array of records (blank when the body is the array, or an object of records). */
  path?: string;
  /** Row id: a template over the record's keys and `constants`, e.g. "{symbol}_{fiscalYear}"; default the record's `id`, else generated. */
  id?: string;
  /** Field id -> source key. Absent: every key of the record, slugged. */
  map?: Record<string, FieldMap>;
  /** Added to every row (and available to the id template), e.g. { symbol: "NVDA" }. */
  constants?: Record<string, Scalar>;
  /** Divide numeric fields by this (1e6: dollars -> $M); fields mapped with scale:false are left alone. */
  scale?: number;
  /** Collapse the records before mapping: order by a key, keep those after a date (or "today"), skip and take
   *  some, and sum listed keys into the first kept record (a trailing-twelve-month figure from four quarters). */
  reduce?: { by?: string; desc?: boolean; after?: string; skip?: number; take?: number; sum?: string[] };
}

export interface TableSource extends Partial<SourceRequest> {
  /** How the requests were derived; kept so the UI can show and edit it. */
  preset?: { id: string; params: Record<string, string> };
  /** Explicit requests (rows merged by id across them); the single-request fields on the source itself are sugar for one. */
  requests?: SourceRequest[];
  /** What a refresh does with the rows: replace (default) makes the fetch the whole table; upsert keeps rows the fetch did not return. */
  mode?: 'replace' | 'upsert';
  // status of the last refresh (written by the engine)
  fetchedAt?: string;
  status?: 'ok' | 'error';
  error?: string;
  fetchedRows?: number;
}

export interface FetchedRows { rows: Record<string, Scalar>[]; columns: string[]; requests: number; warnings: string[] }

export class SourceError extends Error {
  constructor(public code: string, message: string, public fix?: string, public extra: Record<string, unknown> = {}) { super(message); }
}
