/**
 * Fetch a source: resolve secrets, guard the URL, request, parse, map, merge rows by id.
 * Pure over its inputs apart from the network: the caller passes `fetch` (tests pass a stub).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Scalar } from '../store/column.js';
import { parseCsv, slug } from '../store/csv.js';
import { requestsOf } from './presets.js';
import { SourceError, type FetchedRows, type FieldMap, type SourceRequest, type TableSource } from './types.js';

export interface FetchOptions {
  secrets?: Record<string, string>;
  fetch?: typeof fetch;
  /** Allow http and private addresses (local development, tests). Off on a server that others can reach. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRequests?: number;
}

const SECRET = /\{\{\s*secret:([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Every secret name a source refers to. */
export function secretNamesOf(source: TableSource): string[] {
  const names = new Set<string>();
  for (const r of requestsOf(source)) for (const s of [r.url, r.body ?? '', ...Object.values(r.headers ?? {})]) for (const m of s.matchAll(SECRET)) names.add(m[1]);
  return [...names];
}

function resolveSecrets(s: string, secrets: Record<string, string>, missing: Set<string>): string {
  return s.replace(SECRET, (_, name: string) => { const v = secrets[name]; if (v === undefined || v === '') { missing.add(name); return ''; } return v; });
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

/** https only, and never an address inside the network the engine runs in. */
async function guardUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SourceError('SOURCE_BAD_URL', `not a URL: ${raw.slice(0, 120)}`); }
  if (allowPrivate) return u;
  if (u.protocol !== 'https:') throw new SourceError('SOURCE_BAD_URL', `sources are fetched over https only (${u.protocol}//${u.host})`);
  if (u.username || u.password) throw new SourceError('SOURCE_BAD_URL', 'credentials in the URL are not allowed; use a header with a {{secret:name}}');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new SourceError('SOURCE_PRIVATE_HOST', `${host} is not reachable from a source`);
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new SourceError('SOURCE_DNS', `cannot resolve ${host}`); });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new SourceError('SOURCE_PRIVATE_HOST', `${host} resolves to a private address`);
  return u;
}

function pathGet(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const k of path.split('.')) { if (cur === null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
}

function toScalar(v: unknown): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

function transform(v: Scalar, t: string | undefined): Scalar {
  if (v === null || t === undefined) return v;
  switch (t) {
    case 'number': { const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; }
    case 'text': return String(v);
    case 'year': { const m = /^(\d{4})/.exec(String(v)); return m ? Number(m[1]) : null; }
    case 'date': { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v)); return m ? m[1] : null; }
    case 'abs': return typeof v === 'number' ? Math.abs(v) : v;
    case 'neg': return typeof v === 'number' ? -v : v;
    default: return v;
  }
}

/** Fill "{key}" and "{key:year}" from a record and the request's constants. */
function template(t: string, rec: Record<string, unknown>, constants: Record<string, Scalar>): string {
  return t.replace(/\{([a-zA-Z0-9_.]+)(?::([a-z]+))?\}/g, (_, key: string, tr?: string) => {
    const raw = key in constants ? constants[key] : toScalar(pathGet(rec, key));
    const v = transform(raw, tr);
    return v === null || v === undefined ? '' : String(v);
  });
}

/** One record -> one row per the request's map, id template, constants and scale. */
export function mapRecord(rec: Record<string, unknown>, req: SourceRequest, index: number): Record<string, Scalar> {
  const constants = req.constants ?? {};
  const row: Record<string, Scalar> = {};
  const entries: [string, FieldMap][] = req.map ? Object.entries(req.map) : Object.keys(rec).filter(k => k !== 'id').map(k => [slug(k), k] as [string, FieldMap]);
  for (const [field, m] of entries) {
    const from = typeof m === 'string' ? m : m.from;
    const tr = typeof m === 'string' ? undefined : m.transform;
    let v = transform(toScalar(pathGet(rec, from)), tr);
    // scale money-like numbers only: not fields mapped with scale:false, and never a transformed value (a year, a count)
    if (typeof v === 'number' && req.scale && req.scale !== 1 && tr === undefined && !(typeof m === 'object' && m.scale === false)) v = v / req.scale;
    row[field] = v;
  }
  for (const [k, v] of Object.entries(constants)) if (!(k in row)) row[k] = v;
  const id = req.id ? template(req.id, rec, constants) : rec.id !== undefined && rec.id !== null ? String(rec.id) : String(index + 1);
  row.id = id || String(index + 1);
  return row;
}

function parseBody(text: string, contentType: string, req: SourceRequest): Record<string, unknown>[] {
  const format = req.format ?? (contentType.includes('json') ? 'json' : contentType.includes('csv') || contentType.includes('text/plain') ? 'csv' : /^\s*[[{]/.test(text) ? 'json' : 'csv');
  if (format === 'csv') {
    const csv = parseCsv(text);
    return csv.rows.map(r => Object.fromEntries(csv.header.map((h, i) => [h, r[i] ?? ''])));
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SourceError('SOURCE_BAD_BODY', `the response is not JSON: ${text.slice(0, 120)}`); }
  const at = pathGet(data, req.path ?? '');
  if (Array.isArray(at)) return at.filter(x => x && typeof x === 'object') as Record<string, unknown>[];
  if (at && typeof at === 'object') {
    // a single record (FMP profile) or an object of records keyed by id
    const vals = Object.values(at as Record<string, unknown>);
    if (vals.length && vals.every(v => v && typeof v === 'object' && !Array.isArray(v))) return Object.entries(at as Record<string, unknown>).map(([k, v]) => ({ id: k, ...(v as Record<string, unknown>) }));
    return [at as Record<string, unknown>];
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const msg = (data as Record<string, unknown>).message ?? (data as Record<string, unknown>).error ?? (data as Record<string, unknown>)['Error Message'];
    if (typeof msg === 'string') throw new SourceError('SOURCE_PROVIDER', msg);
  }
  throw new SourceError('SOURCE_BAD_BODY', `no records at path "${req.path ?? ''}"`, 'set path to the key that holds the array of records');
}

/** Fetch every request of a source and merge the rows by id. */
export async function fetchSource(source: TableSource, opts: FetchOptions = {}): Promise<FetchedRows> {
  const requests = requestsOf(source);
  const max = opts.maxRequests ?? 60;
  if (requests.length > max) throw new SourceError('SOURCE_TOO_MANY', `${requests.length} requests; the limit is ${max}`, 'fewer tickers or datasets per table');
  const secrets = opts.secrets ?? {};
  const missing = new Set<string>();
  const prepared = requests.map(r => ({
    req: r,
    url: resolveSecrets(r.url, secrets, missing),
    headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, resolveSecrets(v, secrets, missing)])),
    body: r.body === undefined ? undefined : resolveSecrets(r.body, secrets, missing),
  }));
  if (missing.size) throw new SourceError('SOURCE_NO_SECRET', `this source needs the secret${missing.size > 1 ? 's' : ''} ${[...missing].join(', ')}`, 'add it in Integrations (finicast.com) or set the environment variable', { secrets: [...missing] });
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 30000, maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const byId = new Map<string, Record<string, Scalar>>();
  const columns: string[] = [];
  const warnings: string[] = [];
  for (const p of prepared) {
    const u = await guardUrl(p.url, !!opts.allowPrivate);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try { res = await doFetch(u.toString(), { method: p.req.method ?? 'GET', headers: { accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...p.headers }, body: p.body, signal: ctl.signal, redirect: 'manual' }); }
    catch (e) { clearTimeout(timer); throw new SourceError('SOURCE_UNREACHABLE', `${u.host}: ${e instanceof Error ? (e.name === 'AbortError' ? `no response within ${timeout / 1000}s` : e.message) : String(e)}`); }
    let text: string;
    try {
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > maxBytes) throw new SourceError('SOURCE_TOO_LARGE', `${u.host} returned ${(len / 1048576).toFixed(1)} MB; the limit is ${maxBytes / 1048576} MB`);
      text = await res.text();
      if (text.length > maxBytes) throw new SourceError('SOURCE_TOO_LARGE', `${u.host} returned more than ${maxBytes / 1048576} MB`);
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400) throw new SourceError('SOURCE_REDIRECT', `${u.host} redirected (${res.status}); use the final URL`);
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); msg = String(j.message ?? j.error ?? j['Error Message'] ?? msg); } catch { /* keep the text */ }
      throw new SourceError(res.status === 401 || res.status === 403 ? 'SOURCE_UNAUTHORIZED' : 'SOURCE_HTTP', `${u.host} answered ${res.status}: ${msg}`, res.status === 401 || res.status === 403 ? 'check the secret (API key) and the plan it belongs to' : undefined);
    }
    const records = parseBody(text, res.headers.get('content-type') ?? '', p.req);
    if (!records.length) warnings.push(`${u.host}${u.pathname}: no records`);
    records.forEach((rec, i) => {
      const row = mapRecord(rec, p.req, i);
      for (const k of Object.keys(row)) if (k !== 'id' && !columns.includes(k)) columns.push(k);
      const prev = byId.get(row.id as string);
      if (prev) { for (const [k, v] of Object.entries(row)) if (k !== 'id' && (v !== null || !(k in prev))) prev[k] = v; }
      else byId.set(row.id as string, row);
    });
  }
  return { rows: [...byId.values()], columns, requests: prepared.length, warnings };
}

/** Secrets from the environment: FINIDB_SECRET_<NAME>, else <NAME>_API_KEY (fmp -> FMP_API_KEY). */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    let m = /^FINIDB_SECRET_(.+)$/.exec(k); if (m) { out[m[1].toLowerCase()] = v; continue; }
    m = /^(.+)_API_KEY$/.exec(k); if (m) out[m[1].toLowerCase()] ??= v;
  }
  return out;
}
