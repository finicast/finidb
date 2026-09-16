/** AST for the formula language (doc 04 §11). */

export type Literal = number | string | boolean;

export type Keyword = 'first' | 'last' | 'this' | 'all';

export type MemberOrKw = { k: 'member'; v: string | number } | { k: 'kw'; v: Keyword };

export type Bound =
  | { k: 'kw'; v: 'first' | 'last' | 'this'; by?: number }   // this±n
  | { k: 'member'; v: string | number };

export type Selector =
  | { k: 'eq'; path: string[]; op: '=' | '!='; value: MemberOrKw }
  | { k: 'in'; path: string[]; not: boolean; values: (string | number)[] }
  | { k: 'cmp'; path: string[]; op: '<' | '<=' | '>' | '>='; value: Literal }
  | { k: 'range'; path: string[]; from: Bound; to: Bound }
  | { k: 'offset'; dim: string; by: number }
  | { k: 'corr'; path: string[]; right: string[] };          // path = @right

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'blank' }
  | { k: 'bin'; op: BinOp; l: Node; r: Node }
  | { k: 'un'; op: '-' | 'not'; e: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'ref'; parts: string[]; selectors: Selector[]; path: string[]; text: string }   // parts: names before the selector, path: names after
  | { k: 'at'; path: string[] };

export type BinOp = 'or' | 'and' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '&' | '*' | '/' | '^';

export interface ParsedRule {
  target: string[];
  when: Selector[];
  formula: Node;
  formulaText: string;
}
