export type TokType = 'num' | 'str' | 'qname' | 'ident' | 'punct' | 'eof';
export interface Token { t: TokType; v: string | number; pos: number }

const PUNCT = ['..', '!=', '<>', '<=', '>=', '&&', '||', '(', ')', '[', ']', ',', '.', '=', '<', '>', '+', '-', '*', '/', '^', '&', '@', '!'];

export class LexError extends Error {}

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // comments
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    // numbers
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const start = i;
      while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) {
        if (src[i] === '.' && src[i + 1] === '.') break; // range operator
        i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && /[0-9+-]/.test(src[i + 1] ?? '')) { i++; if (src[i] === '+' || src[i] === '-') i++; while (i < n && src[i] >= '0' && src[i] <= '9') i++; }
      let v = Number(src.slice(start, i));
      if (src[i] === '%') { v /= 100; i++; }
      out.push({ t: 'num', v, pos: start });
      continue;
    }
    // strings
    if (c === '"') {
      const start = i; i++;
      let s = '';
      while (i < n && src[i] !== '"') { if (src[i] === '\\' && i + 1 < n) { i++; } s += src[i]; i++; }
      if (i >= n) throw new LexError(`Unterminated string at ${start}`);
      i++;
      out.push({ t: 'str', v: s, pos: start });
      continue;
    }
    if (c === "'") {
      const start = i; i++;
      let s = '';
      while (i < n && src[i] !== "'") { s += src[i]; i++; }
      if (i >= n) throw new LexError(`Unterminated quoted name at ${start}`);
      i++;
      out.push({ t: 'qname', v: s, pos: start });
      continue;
    }
    // identifiers
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      out.push({ t: 'ident', v: src.slice(start, i), pos: start });
      continue;
    }
    // punctuation
    let matched = false;
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) { out.push({ t: 'punct', v: p, pos: i }); i += p.length; matched = true; break; }
    }
    if (!matched) throw new LexError(`Unexpected character '${c}' at ${i}`);
  }
  out.push({ t: 'eof', v: '', pos: n });
  return out;
}
