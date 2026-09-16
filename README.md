# finidb

A BI-style calculation engine for AI agents. Line items × time periods, conditional rules,
incremental recalculation. Use it instead of generating a spreadsheet when the task is a
forecast, budget, plan, financial statement, or any model a human will later open and adjust.

| Your task | Use |
|---|---|
| Clean, join, or reshape data | Pandas / DuckDB |
| Query an existing warehouse | SQL |
| A static chart of static data | matplotlib |
| **Line items × periods with formulas; a forecast, budget or plan; a ledger rolled up into something that stays live** | **finidb** |

## Twelve lines, a whole forecast

```ts
import { FiniDB } from 'finidb'

const f = new FiniDB()
f.createModel('nvda')
f.createPeriods('nvda', 'periods', { start: '2024-01', count: 6, grain: 'year', histUntil: '2026-12-31' })
f.createTable('nvda', 'lines', [{ id: 'name' }, { id: 'category' }], { rows: [
  { id: 'revenue', category: 'flow' }, { id: 'cogs', category: 'flow' }, { id: 'rnd', category: 'opex' },
  { id: 'sga', category: 'opex' }, { id: 'gross_profit', category: 'flow' }, { id: 'opex', category: 'flow' }, { id: 'ebit', category: 'flow' } ] })
f.createTable('nvda', 'financials', [{ id: 'account' }, { id: 'period', ref: 'periods' }, { id: 'amount', type: 'number' }], { rows: [/* …from the filing… */] })
f.createPivot('nvda', 'assumptions', { dims: [{ id: 'driver', table: 'drivers' }, { id: 'period', table: 'periods' }], lineDim: 'driver' })
f.createPivot('nvda', 'income_statement', { dims: [{ id: 'line', table: 'lines' }, { id: 'period', table: 'periods' }], lineDim: 'line', timeDim: 'period' })
f.setRules('nvda', 'income_statement', `
  revenue[frame=hist] = SUM(financials.amount[account=revenue])
  revenue[frame=fcst] = PREV(revenue) * (1 + assumptions.revenue_growth)
  cogs[frame=fcst]    = revenue * assumptions.cogs_pct
  gross_profit        = revenue - cogs
  opex                = SUM(value[line.category = opex])
  ebit                = gross_profit - opex
`)
console.log(f.query('nvda', { table: 'income_statement', rows: ['line'], cols: ['period'] }))
```

```
| line         | FY2024 |  FY2025 |  FY2026 |  FY2027 |  FY2028 |  FY2029 |
|--------------|-------:|--------:|--------:|--------:|--------:|--------:|
| Revenue      | 60,922 | 130,500 | 180,000 | 252,000 | 352,800 | 493,920 |
| COGS         | 16,621 |  32,639 |  45,000 |  63,000 |  88,200 | 123,480 |
| Gross Profit | 44,301 |  97,861 | 135,000 | 189,000 | 264,600 | 370,440 |
```

## The language in one screen

```
Revenue[frame=fcst] = PREV(Revenue) * (1 + growth)      // a rule: target[condition] = expression
GrossProfit         = Revenue - COGS                     // line items are nouns
points              = SUM(activities.score)              // a column of a table is a set; SUM groups it by this pivot's dims
score               = activity_type.score                // a dot follows a reference
total[tranche=all]  = SUM(value[tranche != total])       // member masks
sum_of_subs         = SUM(goal[region.parent = @region]) // @dim is the current cell's member
balance             = balance[row-1] + amount            // tabular running total
```

One reference syntax: a name with an optional `[selector]`. `[period-1]`, `[period=first..this]`,
`[line in (a, b)]`, `[period.year >= 2027]`, `[rep.territory = @territory]`. Every reference is
statically classifiable, which is what lets the engine recompute only what changed.

## Build a model from a document (no server needed)

```sh
npx finidb build model.json          # prints the statements; see examples/coreweave.json for the document format
```

The document (periods, pivots with line items, historical inputs and rules, tables, outputs, and
optionally `dashboards`: an editable assumptions table plus charts, built when the document is
imported on finicast.com; bars for amounts, lines for rates, chosen from each line's `format` when a
card gives no `type`) is the same one finicast.com accepts at `POST https://finicast.com/api/build`. `finidb build` also
prints a link of the form `https://finicast.com/import#m=…` with the model deflate-compressed in
the URL fragment: opening it builds a live, editable workspace from the browser, so an agent in a
sandbox that can only reach npm can still hand the user a link (`modelLink(doc)` in the API).
Pasting the document at https://finicast.com/import does the same by hand.

## Status

Design in `../docs/design`. Implemented (first cut of milestones M1–M5):

- **Engine**: column store, schema, parser, 100+ functions, `PERIOD(date)`, the reference
  evaluator (the oracle) and the incremental engine (dense per-column storage, recorded
  dependencies, row-level dirty sets propagated through reference columns, integer-bucket
  delta aggregates, tier-2 compiled row rules). A differential test runs random edit sequences
  through both engines and compares every cell.
- **Persistence**: JSONL oplog with content-addressed blobs for bulk loads, binary snapshots of
  inputs only, `openDatabase(dir)` (snapshot + log tail).
- **Server + CLI**: `finidb serve` (node:http, multi-database, users/grants with scrypt, Basic
  and bearer auth, the REST routes of doc 07, long-poll `/changes`, CSV load, batch), `finidb
  createdb | createuser | grant | query | rules | load | bench | build`.
- **MCP + skill**: nine tools (`src/mcp`), `finidb mcp` for stdio, `finidb skill` prints
  `skill/SKILL.md` (syntax, recipes and error references); `finidb skill --install <dir>` copies
  the whole skill folder.
- **Model documents**: `finidb build model.json` applies a JSON model document (periods, pivots
  with lines, inputs and rules, tables) in-process and prints the requested pivots as markdown or
  JSON — no server needed. Pivots may reference each other across periods (income statement,
  cash flow and balance sheet in separate pivots); the engine resolves the cross-pivot recurrence
  cell by cell.

```
npm test                              # 49 tests: unit, models, differential, persistence, server, MCP
node --import tsx bench/run.ts 100000 # B1 sales-ops benchmark
npm run build && node dist/cli/finidb.js serve --data-dir ./data
FINIDB_DIR=./data npx finidb mcp      # MCP over stdio, persistent
npx finidb build examples/coreweave.json   # model document → markdown statements
```

B1, 100,000 activities, incremental engine, measured 2026-09-15 on a shared host with a load
average above 5 (treat as upper bounds):

| Case | p50 |
|---|---|
| one activity's type changes → territory pivot read | 2–5 ms |
| one activity's rep changes | 2–4 ms |
| one rep moves territory (~500 rows) | 3–4 ms |
| one scoring value changes (~25k rows recomputed + delta) | 23–35 ms |
| reorient the view (no recompute) | < 1 ms |

Known gaps: pivot measure columns recompute whole-column on any change (fine at 10³–10⁴ cells,
not yet at 10⁵+); no worker-per-database; `/batch` is not atomic; no delete routes beyond
`dropTable`/`dropModel` in the facade; the web workspace (M6–M8) is not started.

## License

Free for personal, educational, research and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires a paid license from
Finicast, Inc.; see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) or write to licensing@finicast.com.
