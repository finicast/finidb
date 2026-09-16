import { lex, Token } from './lexer.js';
import type { Node, Selector, ParsedRule, Bound, MemberOrKw, BinOp, Literal } from './ast.js';

export class ParseError extends Error {
  constructor(msg: string, public pos: number) { super(msg); }
}

const KW = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'blank']);

class Parser {
  toks: Token[];
  i = 0;
  constructor(public src: string) { this.toks = lex(src); }

  peek(o = 0): Token { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next(): Token { return this.toks[this.i++]; }
  isPunct(v: string, o = 0): boolean { const t = this.peek(o); return t.t === 'punct' && t.v === v; }
  isKw(v: string, o = 0): boolean { const t = this.peek(o); return t.t === 'ident' && String(t.v).toLowerCase() === v; }
  expectPunct(v: string): Token {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new ParseError(`Expected '${v}' but found '${t.v}'`, t.pos);
    return t;
  }
  fail(msg: string): never { throw new ParseError(msg, this.peek().pos); }

  // ---- expressions ----
  expr(): Node { return this.orExpr(); }
  orExpr(): Node {
    let l = this.andExpr();
    while (this.isKw('or') || this.isPunct('||')) { this.next(); l = { k: 'bin', op: 'or', l, r: this.andExpr() }; }
    return l;
  }
  andExpr(): Node {
    let l = this.notExpr();
    while (this.isKw('and') || this.isPunct('&&')) { this.next(); l = { k: 'bin', op: 'and', l, r: this.notExpr() }; }
    return l;
  }
  notExpr(): Node {
    if (this.isKw('not') || this.isPunct('!')) { this.next(); return { k: 'un', op: 'not', e: this.notExpr() }; }
    return this.cmpExpr();
  }
  cmpExpr(): Node {
    const l = this.addExpr();
    const t = this.peek();
    if (t.t === 'punct' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v as string)) {
      this.next();
      const op = (t.v === '<>' ? '!=' : t.v) as BinOp;
      return { k: 'bin', op, l, r: this.addExpr() };
    }
    return l;
  }
  addExpr(): Node {
    let l = this.mulExpr();
    while (this.isPunct('+') || this.isPunct('-') || this.isPunct('&')) {
      const op = this.next().v as BinOp;
      l = { k: 'bin', op, l, r: this.mulExpr() };
    }
    return l;
  }
  mulExpr(): Node {
    let l = this.powExpr();
    while (this.isPunct('*') || this.isPunct('/')) { const op = this.next().v as BinOp; l = { k: 'bin', op, l, r: this.powExpr() }; }
    return l;
  }
  powExpr(): Node {
    let l = this.unary();
    while (this.isPunct('^')) { this.next(); l = { k: 'bin', op: '^', l, r: this.unary() }; }
    return l;
  }
  unary(): Node {
    if (this.isPunct('-')) { this.next(); return { k: 'un', op: '-', e: this.unary() }; }
    if (this.isPunct('+')) { this.next(); return this.unary(); }
    return this.primary();
  }
  primary(): Node {
    const t = this.peek();
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v as number }; }
    if (t.t === 'str') { this.next(); return { k: 'str', v: t.v as string }; }
    if (t.t === 'punct' && t.v === '(') { this.next(); const e = this.expr(); this.expectPunct(')'); return e; }
    if (t.t === 'punct' && t.v === '@') { this.next(); return { k: 'at', path: this.path() }; }
    if (t.t === 'ident') {
      const low = String(t.v).toLowerCase();
      if (low === 'true') { this.next(); return { k: 'bool', v: true }; }
      if (low === 'false') { this.next(); return { k: 'bool', v: false }; }
      if (low === 'blank') { this.next(); if (this.isPunct('(')) { this.next(); this.expectPunct(')'); } return { k: 'blank' }; }
      if (this.isPunct('(', 1)) {
        // function call
        this.next(); this.next();
        const args: Node[] = [];
        if (!this.isPunct(')')) { args.push(this.expr()); while (this.isPunct(',')) { this.next(); args.push(this.expr()); } }
        this.expectPunct(')');
        return { k: 'call', name: String(t.v).toUpperCase(), args };
      }
    }
    if (t.t === 'ident' || t.t === 'qname') return this.reference();
    this.fail(`Unexpected token '${t.v}'`);
  }

  name(): string {
    const t = this.next();
    if (t.t !== 'ident' && t.t !== 'qname') throw new ParseError(`Expected a name but found '${t.v}'`, t.pos);
    if (t.t === 'ident' && KW.has(String(t.v).toLowerCase())) throw new ParseError(`'${t.v}' is a keyword`, t.pos);
    return String(t.v);
  }
  path(): string[] {
    const p = [this.name()];
    while (this.isPunct('.') && (this.peek(1).t === 'ident' || this.peek(1).t === 'qname')) { this.next(); p.push(this.name()); }
    return p;
  }

  /** reference := parts ['[' selectors ']'] {'.' name}   — the resolver decides which parts are qualifier/name/path */
  reference(): Node {
    const start = this.peek().pos;
    const parts: string[] = [this.name()];
    while (this.isPunct('.') && (this.peek(1).t === 'ident' || this.peek(1).t === 'qname')) { this.next(); parts.push(this.name()); }
    let selectors: Selector[] = [];
    if (this.isPunct('[')) selectors = this.selectors();
    const path: string[] = [];
    while (this.isPunct('.') && (this.peek(1).t === 'ident' || this.peek(1).t === 'qname')) { this.next(); path.push(this.name()); }
    const end = this.peek().pos;
    return { k: 'ref', parts, selectors, path, text: this.src.slice(start, end).trim() };
  }

  selectors(): Selector[] {
    this.expectPunct('[');
    const out: Selector[] = [];
    if (!this.isPunct(']')) { out.push(this.selector()); while (this.isPunct(',')) { this.next(); out.push(this.selector()); } }
    this.expectPunct(']');
    return out;
  }
  selector(): Selector {
    const p = this.path();
    const t = this.peek();
    if (t.t === 'punct' && (t.v === '+' || t.v === '-')) {
      this.next();
      const n = this.next();
      if (n.t !== 'num') throw new ParseError('Expected a number after offset sign', n.pos);
      if (p.length !== 1) throw new ParseError('Offsets apply to a dimension, not an attribute', t.pos);
      return { k: 'offset', dim: p[0], by: t.v === '-' ? -(n.v as number) : (n.v as number) };
    }
    if (this.isKw('in') || (this.isKw('not') && this.isKw('in', 1))) {
      let not = false;
      if (this.isKw('not')) { this.next(); not = true; }
      this.next();
      this.expectPunct('(');
      const values: (string | number)[] = [this.memberLiteral()];
      while (this.isPunct(',')) { this.next(); values.push(this.memberLiteral()); }
      this.expectPunct(')');
      return { k: 'in', path: p, not, values };
    }
    if (t.t === 'punct' && (t.v === '=' || t.v === '!=' || t.v === '<>')) {
      this.next();
      const op = t.v === '<>' ? '!=' : (t.v as '=' | '!=');
      if (this.isPunct('@')) { this.next(); return { k: 'corr', path: p, right: this.path() }; }
      const first = this.bound();
      if (this.isPunct('..')) {
        this.next();
        const to = this.bound();
        if (op !== '=') throw new ParseError('Ranges use =', t.pos);
        return { k: 'range', path: p, from: first, to };
      }
      let value: MemberOrKw;
      if (first.k === 'kw') { value = first.by ? this.fail('this±n is only valid in a range') : { k: 'kw', v: first.v }; }
      else value = { k: 'member', v: first.v };
      return { k: 'eq', path: p, op, value };
    }
    if (t.t === 'punct' && ['<', '<=', '>', '>='].includes(t.v as string)) {
      this.next();
      const lit = this.literal();
      return { k: 'cmp', path: p, op: t.v as '<' | '<=' | '>' | '>=', value: lit };
    }
    this.fail(`Unexpected '${t.v}' in selector`);
  }
  bound(): Bound {
    const t = this.peek();
    if (t.t === 'ident') {
      const low = String(t.v).toLowerCase();
      if (low === 'first' || low === 'last' || low === 'all') { this.next(); return { k: 'kw', v: low as 'first' | 'last' } as Bound; }
      if (low === 'this') {
        this.next();
        if (this.isPunct('+') || this.isPunct('-')) {
          const s = this.next().v; const n = this.next();
          if (n.t !== 'num') throw new ParseError('Expected a number', n.pos);
          return { k: 'kw', v: 'this', by: s === '-' ? -(n.v as number) : (n.v as number) };
        }
        return { k: 'kw', v: 'this' };
      }
    }
    return { k: 'member', v: this.memberLiteral() };
  }
  memberLiteral(): string | number {
    const t = this.next();
    if (t.t === 'num') return t.v as number;
    if (t.t === 'str' || t.t === 'qname' || t.t === 'ident') return String(t.v);
    throw new ParseError(`Expected a member but found '${t.v}'`, t.pos);
  }
  literal(): Literal {
    const t = this.next();
    if (t.t === 'num') return t.v as number;
    if (t.t === 'str' || t.t === 'qname' || t.t === 'ident') {
      const low = String(t.v).toLowerCase();
      if (t.t === 'ident' && low === 'true') return true;
      if (t.t === 'ident' && low === 'false') return false;
      return String(t.v);
    }
    throw new ParseError(`Expected a literal but found '${t.v}'`, t.pos);
  }

  /** rule := reference '=' expr */
  rule(): ParsedRule {
    const target = this.reference();
    if (target.k !== 'ref') this.fail('Expected a rule target');
    if (target.path.length) this.fail('A rule target cannot have an attribute path');
    this.expectPunct('=');
    const start = this.peek().pos;
    const formula = this.expr();
    if (this.peek().t !== 'eof') this.fail(`Unexpected '${this.peek().v}' after formula`);
    return { target: target.parts, when: target.selectors, formula, formulaText: this.src.slice(start).trim() };
  }
}

export function parseExpression(src: string): Node {
  const p = new Parser(src);
  const e = p.expr();
  if (p.peek().t !== 'eof') throw new ParseError(`Unexpected '${p.peek().v}'`, p.peek().pos);
  return e;
}

export function parseRule(src: string): ParsedRule {
  return new Parser(src).rule();
}

/** Parse a block of rules, one per line; blank lines and comment lines ignored. */
export function parseRules(src: string): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    out.push(parseRule(line));
  }
  return out;
}
