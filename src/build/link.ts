/**
 * Share links: a model document folded into the fragment of a finicast.com/import URL.
 *
 * `finidb build` prints one of these so an agent that cannot reach finicast.com (sandboxed code execution only
 * reaches package registries) can still hand the user a link. The document travels deflate-compressed and
 * base64url-encoded after the `#`, which the browser never sends to the server; the import page decodes it and
 * builds the workspace from the user's own browser. A three-statement model is around 1–2 KB encoded.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { ModelDocument } from './document.js';

export const DEFAULT_SITE = 'https://finicast.com';
export const LINK_PARAM = 'm';
export const PLAIN_PARAM = 'j';

export function encodeModelFragment(doc: ModelDocument | object): string {
  return deflateRawSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 }).toString('base64url');
}
export function decodeModelFragment(encoded: string): ModelDocument {
  const json = inflateRawSync(Buffer.from(encoded, 'base64url')).toString('utf8');
  const doc = JSON.parse(json);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('LINK_NOT_DOCUMENT: the link does not carry a model document');
  return doc as ModelDocument;
}

/** `https://finicast.com/import#m=<deflate+base64url document>` — open it to get a live workspace. */
export function modelLink(doc: ModelDocument | object, site = process.env.FINICAST_SITE ?? DEFAULT_SITE): string {
  return `${site.replace(/\/$/, '')}/import#${LINK_PARAM}=${encodeModelFragment(doc)}`;
}
/** Read the document back out of a share link (or a bare fragment). */
export function parseModelLink(link: string): ModelDocument {
  const hash = link.includes('#') ? link.slice(link.indexOf('#') + 1) : link;
  const params = new URLSearchParams(hash);
  const plain = params.get(PLAIN_PARAM);
  if (plain) return JSON.parse(Buffer.from(plain, 'base64url').toString('utf8')) as ModelDocument;
  return decodeModelFragment(params.get(LINK_PARAM) ?? hash);
}
/** The uncompressed form, `…/import#j=<base64url JSON>`: longer, but needs nothing beyond base64. */
export function modelLinkPlain(doc: ModelDocument | object, site = process.env.FINICAST_SITE ?? DEFAULT_SITE): string {
  return `${site.replace(/\/$/, '')}/import#${PLAIN_PARAM}=${Buffer.from(JSON.stringify(doc), 'utf8').toString('base64url')}`;
}
