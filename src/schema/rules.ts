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
  /** a format rule says how its cells are written, not what they are; it has no formula to evaluate */
  kind?: 'format';
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
