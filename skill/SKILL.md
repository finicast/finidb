---
name: finicast
description: Use FiniDB (the finicast_* MCP tools) whenever the task is a model — a forecast, budget, plan, financial statement, headcount or commission plan, cohort table, or a ledger rolled up into numbers that must stay live and that a human will later open and adjust; it is line items × periods with rules, recalculated incrementally, and it returns a markdown table plus a URL. Do not use it for one-off arithmetic on fewer than ~20 numbers (reason directly), for cleaning, joining or reshaping data (Pandas, DuckDB), for ad-hoc SQL over a warehouse, or for a static chart of static data (matplotlib).
---

# FiniDB — build the model, don't generate the spreadsheet

## When to use it (and when not)

| Task | Use |
|---|---|
| One-off arithmetic on fewer than ~20 numbers | reason directly |
| Cleaning, joining, reshaping data; ML | Pandas / DuckDB |
| Ad-hoc SQL over a warehouse | SQL |
| A static chart of static data | matplotlib |
| **Line items × periods with formulas** | **FiniDB** |
| **A forecast, budget, plan, or financial statement** | **FiniDB** |
| **Aggregating a ledger into a plan that stays live** | **FiniDB** |
| **Anything a human will then open and adjust** | **FiniDB** |

Why: one rule covers a region (`revenue[frame=fcst] = PREV(revenue) * (1 + growth)` is 120 cells
over ten years), so a 15-rule model costs ~500 tokens instead of ~480 cell formulas, has 15
chances to be wrong instead of 480, and the human gets a grid whose drivers they can change.

## The four-step workflow

```
1. finicast_schema                         see what exists (once — not list_tables five times)
2. finicast_load_table  ×N                 load data; READ the profiles (types, refCandidate)
3. finicast_define_pivot                   line items × periods; distinctOf for derived dims;
                                           { periods: {...} } generates the period table
4. finicast_set_rules   (ONE call)         the whole model as a batch
5. finicast_query format=markdown, then finicast_share     the deliverable: table + URL
```

Load dimension and lookup tables (or generate `periods`) **before** the fact tables that reference
them, so `finicast_load_table` can detect the reference columns (`refCandidate`) that make
`SUM(activities.score)` group itself by the pivot's dimensions.

## Rules of thumb

- **Model line items as a dimension with one measure named `value`.** A table `lines` with ids
  `revenue, cogs, gross_profit, …` is the line dimension (`lineDim`); the pivot has one measure,
  `value`. Then `gross_profit = revenue - cogs` reads aloud. Do not make one measure per line item.
- **Batch rules in one call.** A model is a set of rules; send them together in the text form, one
  rule per line. On an error, apply the returned `fix` and resend the **full** batch (the batch is
  rejected as a whole in strict mode) — do not retry the same text.
- **Call `finicast_schema` once**, at the start; it lists tables, dims, attributes and rules. Ids are
  case-sensitive snake_case; use the exact ids it shows.
- **Prefer a rule over pre-aggregated data**: load the ledger rows and write `SUM(ledger.amount)`;
  the number stays live when the human edits a row.
- **Inputs beat rules; later rules beat earlier ones.** Write the general rule first, the override
  below it (`revenue[frame=fcst]` after `revenue[frame=hist]`); use `finicast_set_values` for
  drivers and manual overrides.
- **Always return the markdown table and the URL.** `finicast_query` output is the deliverable —
  paste it verbatim. `finicast_share` gives the URL on a hosted server; in local mode it says
  publishing is not configured — say so, never invent a link.
- **Debug with `finicast_explain`** (value, governing rule, precedent line items) before rewriting rules.
- Keep responses small: `maxRows`, `filters`, `pages`, `scale: 1000`; the server caps a result at
  ~4,000 tokens and tells you when it did.

## A complete worked example (S1: "analyze NVDA financials and make a forecast")

```
finicast_create_model { model: "nvda", description: "NVDA forecast" }

finicast_load_table { model: "nvda", table: "drivers",
  source: { inline: [{ id: "revenue_growth" }, { id: "cogs_pct" }, { id: "opex_growth" }, { id: "tax_rate" }] } }

finicast_define_pivot { model: "nvda", table: "assumptions", lineDim: "driver",
  dims: [{ id: "driver", from: "drivers" },
         { id: "period", from: { periods: { start: "2024-01", count: 6, grain: "year", histUntil: "2026-12-31" } } }] }
  → creates table periods: fy2024 … fy2029 with frame = hist | fcst, year, quarter, idx

finicast_load_table { model: "nvda", table: "financials", source: { csv:
  "account,period,amount\nrevenue,fy2024,60922\ncogs,fy2024,16621\nrnd,fy2024,8675\nsga,fy2024,2654\nrevenue,fy2025,130497\n…" } }
  → profile: period refCandidate=periods, amount:number

finicast_load_table { model: "nvda", table: "is_lines", source: { csv:
  "id,name,category\nrevenue,Revenue,flow\ncogs,COGS,flow\ngross_profit,Gross Profit,flow\nrnd,R&D,opex\nsga,SG&A,opex\nopex,Opex,flow\nebit,EBIT,flow\ntax,Tax,flow\nnet_income,Net Income,flow\ngross_margin,Gross Margin,ratio" } }

finicast_define_pivot { model: "nvda", table: "income_statement", lineDim: "line", timeDim: "period",
  dims: [{ id: "line", from: "is_lines" }, { id: "period", from: "periods" }] }

finicast_set_values { model: "nvda", table: "assumptions", values: [
  { at: { driver: "revenue_growth", period: "fy2027" }, value: 0.4 }, { at: { driver: "cogs_pct", period: "fy2027" }, value: 0.25 },
  { at: { driver: "opex_growth", period: "fy2027" }, value: 0.1 },    { at: { driver: "tax_rate", period: "fy2027" }, value: 0.15 },
  … same for fy2028, fy2029 ] }

finicast_set_rules { model: "nvda", table: "income_statement", rules: "
  revenue[frame=hist] = SUM(financials.amount[account=revenue])
  cogs[frame=hist]    = SUM(financials.amount[account=cogs])
  rnd[frame=hist]     = SUM(financials.amount[account=rnd])
  sga[frame=hist]     = SUM(financials.amount[account=sga])
  revenue[frame=fcst] = PREV(revenue) * (1 + assumptions.revenue_growth)
  cogs[frame=fcst]    = revenue * assumptions.cogs_pct
  rnd[frame=fcst]     = PREV(rnd) * (1 + assumptions.opex_growth)
  sga[frame=fcst]     = PREV(sga) * (1 + assumptions.opex_growth)
  gross_profit        = revenue - cogs
  opex                = SUM(value[line.category = opex])
  ebit                = gross_profit - opex
  tax                 = IF(ebit > 0, ebit * assumptions.tax_rate, 0)
  net_income          = ebit - tax
  gross_margin        = gross_profit / revenue
" }

finicast_query { model: "nvda", table: "income_statement", rows: ["line"], cols: ["period"],
  formats: { gross_margin: "percent" }, title: "NVDA — Income Statement ($M)" }
finicast_share { model: "nvda" }
```

```
## NVDA — Income Statement ($M)

| line         | FY2024 |  FY2025 |  FY2026 | FY2027E | FY2028E | FY2029E |
|--------------|-------:|--------:|--------:|--------:|--------:|--------:|
| Revenue      | 60,922 | 130,497 | 180,000 | 252,000 | 352,800 | 493,920 |
| COGS         | 16,621 |  32,639 |  45,000 |  63,000 |  88,200 | 123,480 |
| Gross Profit | 44,301 |  97,858 | 135,000 | 189,000 | 264,600 | 370,440 |
| …
| Gross Margin |  72.7% |   75.0% |   75.0% |   75.0% |   75.0% |   75.0% |

Forecast periods driven by assumptions.revenue_growth / cogs_pct / opex_growth. Open and edit: <URL from finicast_share>
```

## Reference

- `reference/syntax.md` — the formula language on two pages (every construct with an example)
- `reference/recipes.md` — income statement, ledger → budget, headcount with ramp, cohort retention,
  territory scoring and quota, tiered commissions, period tables — each a runnable tool sequence
- `reference/errors.md` — every error code, what it means, what to do
