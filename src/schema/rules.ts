import type { Node } from '../lang/ast.js';

export type ClauseOp = '=' | '!=' | 'in' | 'not in' | '<' | '<=' | '>' | '>=';

export interface Clause {
  /** dim id, attribute path (period.frame) or field id */
  left: string;
  op: ClauseOp;
  right: string | number | boolean | (string | number)[];
}

export interface Rule {
  iid: number;
  /** measure id (pivot) or field id (tabular) */
  target: string;
  when: Clause[];
  formula: string;
  order: number;
  name?: string;
  status: 'ok' | 'invalid';
  error?: string;
  /** a corrected fragment when the compiler can suggest one */
  fix?: string;
  /** parsed formula */
  ast?: Node;
}
