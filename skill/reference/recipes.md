# Recipes

Complete, tested model documents ship in the package under `examples/` (also at
https://finicast.com/examples/<name>.json). Run one with `npx finidb build examples/<name>.json`
and adapt it:

| File | Shows |
|---|---|
| `dcf.json` | assumptions → free cash flow → valuation; `period.idx` discounting, terminal value, `NPV()` cross-check, a pivot without the period dim (`"dims": { "period": false }`) |
| `comparables.json` | multiples from company attributes, `MEDIAN(comps.value[company.kind=peer])`, implied value of the subject |
| `precedents.json` | deal multiples, `MEDIAN(multiples.value[deal.year >= 2024])` |
| `salesops.json` | a $55M ARR SaaS sales org: 2,000 opportunities, marketing funnel, BDR activity, monthly pivots rolled into quarters through `period.quarter`, commission tranches with accelerators from an editable plan, new-logo and multi-year kickers, a SPIFF, a payout cap, team/region/segment/company roll-ups, an ARR bridge, six persona dashboards |
| `budget-vs-actual.json` | ledger with `PERIOD(date, periods)` → subsidiary × department × line × month, a versions dimension, a `text` measure for manager commentary |
| `ledger-to-model.json` | CSV in the document, `distinctOf` dims, actual months then plan months |
| `scenarios.json` | scenarios as a dimension, drivers per scenario, outputs paged by scenario |
| `coreweave.json` | three statements referencing each other, a dashboard with editable drivers |

The walkthroughs below use the MCP tools for the same shapes.

# FiniDB recipes

Each recipe is a complete, runnable sequence of `finicast_*` tool calls. Arguments are shown as
JSON-ish; rules are the text form (one per line). Order matters: dimension and period tables before
the fact tables that reference them; pivots before their rules. Every recipe ends with
`finicast_query` (paste the markdown) and `finicast_share` (paste the URL when one is returned).

1. Income statement with hist/fcst frames
2. Ledger → budget (actuals rolled up, plan driven)
3. Headcount plan with hire dates and ramp
4. Cohort retention
5. Territory scoring and quota
6. Tiered commission calculator
7. Period tables

---

## 1. Income statement with hist/fcst frames

Actual periods come from a ledger-shaped `financials` table; forecast periods are driven by an
`assumptions` pivot the human can edit.

```
finicast_create_model { model: "nvda", description: "NVDA forecast" }

finicast_load_table { model: "nvda", table: "drivers",
  source: { inline: [{ id: "revenue_growth" }, { id: "cogs_pct" }, { id: "opex_growth" }, { id: "tax_rate" }] } }

finicast_define_pivot { model: "nvda", table: "assumptions", lineDim: "driver",
  dims: [{ id: "driver", from: "drivers" },
         { id: "period", from: { periods: { start: "2024-01", count: 6, grain: "year", histUntil: "2026-12-31" } } }] }

finicast_load_table { model: "nvda", table: "financials", source: { csv:
"account,period,amount
revenue,fy2024,60922
cogs,fy2024,16621
rnd,fy2024,8675
sga,fy2024,2654
revenue,fy2025,130497
cogs,fy2025,32639
rnd,fy2025,12914
sga,fy2025,3491
revenue,fy2026,180000
cogs,fy2026,45000
rnd,fy2026,16000
sga,fy2026,4000" } }
  → fields: account (text), period (ref → periods), amount (number)

finicast_load_table { model: "nvda", table: "is_lines", source: { csv:
"id,name,category
revenue,Revenue,flow
cogs,COGS,flow
gross_profit,Gross Profit,flow
rnd,R&D,opex
sga,SG&A,opex
opex,Opex,flow
ebit,EBIT,flow
tax,Tax,flow
net_income,Net Income,flow
gross_margin,Gross Margin,ratio
cum_ni,Cumulative NI,flow" } }

finicast_define_pivot { model: "nvda", table: "income_statement", lineDim: "line", timeDim: "period",
  dims: [{ id: "line", from: "is_lines" }, { id: "period", from: "periods" }] }

finicast_set_values { model: "nvda", table: "assumptions", values: [
  { at: { driver: "revenue_growth", period: "fy2027" }, value: 0.4 }, { at: { driver: "cogs_pct", period: "fy2027" }, value: 0.25 },
  { at: { driver: "opex_growth", period: "fy2027" }, value: 0.1 },    { at: { driver: "tax_rate", period: "fy2027" }, value: 0.15 },
  … repeat for fy2028 and fy2029 ] }

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
  cum_ni              = CUMSUM(net_income)
" }

finicast_query { model: "nvda", table: "income_statement", rows: ["line"], cols: ["period"],
  formats: { gross_margin: "percent" }, title: "NVDA — Income Statement ($M)" }
finicast_share { model: "nvda" }
```

Variations: `revenue[frame=fcst, period.year >= 2028] = …` for a second-stage growth rate;
`finicast_set_values` on `income_statement` to override one forecast cell (the input wins).

---

## 2. Ledger → budget

A ledger CSV with a date column becomes actuals by cost center and month; plan months grow from the
last actual by a driver. The period is derived from the date with a computed reference field.

```
finicast_create_model { model: "budget" }

finicast_load_table { model: "budget", table: "drivers", source: { inline: [{ id: "growth" }] } }

finicast_define_pivot { model: "budget", table: "assumptions", lineDim: "driver",
  dims: [{ id: "driver", from: "drivers" },
         { id: "period", from: { periods: { start: "2026-01", count: 12, grain: "month", histUntil: "2026-06-30" } } }] }
  → periods jan26 … dec26; jan26–jun26 frame=hist, jul26–dec26 frame=fcst

finicast_load_table { model: "budget", table: "ledger",
  options: { computed: [{ id: "period", ref: "periods" }] },
  source: { csv:
"date,cost_center,account,amount
2026-01-15,sales,travel,1200
2026-01-20,sales,software,300
2026-02-03,sales,travel,900
2026-02-11,eng,cloud,4000
2026-03-09,eng,cloud,4200
2026-04-14,sales,travel,1100
2026-05-02,eng,cloud,4400
2026-06-18,sales,software,350
2026-06-25,eng,cloud,4500" } }

finicast_set_rules { model: "budget", table: "ledger", rules: "period = PERIOD(date, periods)" }

finicast_load_table { model: "budget", table: "lines",
  source: { inline: [{ id: "actual" }, { id: "plan" }, { id: "variance" }] } }

finicast_define_pivot { model: "budget", table: "budget", lineDim: "line", timeDim: "period",
  dims: [{ id: "cost_center", from: { distinctOf: "ledger.cost_center" } },
         { id: "line", from: "lines" },
         { id: "period", from: "periods" }] }

finicast_set_values { model: "budget", table: "assumptions", values: [
  { at: { driver: "growth", period: "jul26" }, value: 0.02 }, { at: { driver: "growth", period: "aug26" }, value: 0.02 },
  … through dec26 ] }

finicast_set_rules { model: "budget", table: "budget", rules: "
  actual           = SUM(ledger.amount[cost_center=@cost_center])
  plan[frame=hist] = actual
  plan[frame=fcst] = PREV(plan) * (1 + assumptions.growth)
  variance         = actual - plan
" }

finicast_query { model: "budget", table: "budget", rows: ["cost_center", "line"], cols: ["period"], title: "Budget by cost center" }
finicast_share { model: "budget" }
```

Notes: `ledger.period` is a ref, so the period key is inferred; `cost_center` is text with a
`distinctOf` dimension, so it needs the explicit `[cost_center=@cost_center]`. To plan by account
too, add `{ id: "account", from: { distinctOf: "ledger.account" } }` and `account=@account`.

---

## 3. Headcount plan with hire dates and ramp

A hire × period pivot computes activity, tenure and ramp per hire; a summary pivot sums it.

```
finicast_create_model { model: "hc" }

finicast_load_table { model: "hc", table: "hc_lines",
  source: { inline: [{ id: "headcount" }, { id: "productive_fte" }, { id: "cost" }] } }

finicast_define_pivot { model: "hc", table: "headcount", lineDim: "line", timeDim: "period",
  dims: [{ id: "line", from: "hc_lines" },
         { id: "period", from: { periods: { start: "2026-01", count: 12, grain: "month" } } }] }

finicast_load_table { model: "hc", table: "hires",
  options: { computed: [{ id: "start_period", ref: "periods" }] },
  source: { csv:
"id,role,start_date,salary,ramp_months
h1,AE,2026-01-01,120000,3
h2,AE,2026-03-15,120000,3
h3,SE,2026-06-01,150000,2
h4,AE,2026-09-01,120000,3" } }

finicast_set_rules { model: "hc", table: "hires", rules: "start_period = PERIOD(start_date, periods)" }

finicast_load_table { model: "hc", table: "hp_lines",
  source: { inline: [{ id: "active" }, { id: "tenure" }, { id: "ramp" }, { id: "cost" }] } }

finicast_define_pivot { model: "hc", table: "hire_plan", lineDim: "line", timeDim: "period",
  dims: [{ id: "hire", from: "hires" }, { id: "line", from: "hp_lines" }, { id: "period", from: "periods" }] }

finicast_set_rules { model: "hc", table: "hire_plan", rules: "
  active = IF(period.idx >= hire.start_period.idx, 1, 0)
  tenure = IF(active = 1, period.idx - hire.start_period.idx + 1, 0)
  ramp   = IF(tenure >= hire.ramp_months, active, tenure / hire.ramp_months)
  cost   = active * hire.salary / 12
" }

finicast_set_rules { model: "hc", table: "headcount", rules: "
  headcount      = SUM(hire_plan.active)
  productive_fte = SUM(hire_plan.ramp)
  cost           = SUM(hire_plan.cost)
" }

finicast_query { model: "hc", table: "headcount", rows: ["line"], cols: ["period"], title: "Headcount plan" }
finicast_query { model: "hc", table: "hire_plan", rows: ["hire"], cols: ["period"], pages: { line: "ramp" } }
finicast_share { model: "hc" }
```

Attrition: add an `end_date` column and `end_period = PERIOD(end_date, periods)`, then
`active = IF(AND(period.idx >= hire.start_period.idx, OR(ISBLANK(hire.end_period), period.idx < hire.end_period.idx)), 1, 0)`.

---

## 4. Cohort retention

Customers carry a signup period and an optional churn period. The cohort is its own small table
(`cohorts`, with an `idx` to compare against `period.idx`) — do **not** define two dims over the same
`periods` table, selectors on the second one would resolve to the first.

```
finicast_create_model { model: "retention" }

finicast_load_table { model: "retention", table: "ret_lines",
  source: { inline: [{ id: "starting" }, { id: "churned" }, { id: "active" }, { id: "retained_pct" }] } }

finicast_load_table { model: "retention", table: "cohorts", source: { csv:
"id,idx
jan26,0
feb26,1
mar26,2
apr26,3
may26,4
jun26,5" } }

finicast_define_pivot { model: "retention", table: "retention", lineDim: "line", timeDim: "period",
  dims: [{ id: "cohort", from: "cohorts" }, { id: "line", from: "ret_lines" },
         { id: "period", from: { periods: { start: "2026-01", count: 6, grain: "month" } } }] }
  → periods jan26 … jun26 (same ids as cohorts)

finicast_load_table { model: "retention", table: "customers", source: { csv:
"id,signup_period,churn_period
c1,jan26,
c2,jan26,mar26
c3,jan26,apr26
c4,feb26,
c5,feb26,may26
c6,mar26,
c7,mar26,jun26
c8,mar26," } }
  → signup_period and churn_period detected as refs (blank = never churned)

finicast_set_rules { model: "retention", table: "retention", rules: "
  starting     = COUNTD(customers.id[signup_period=@cohort])
  churned      = COUNTD(customers.id[signup_period=@cohort, churn_period=@period])
  active       = IF(period.idx < cohort.idx, BLANK, starting - CUMSUM(churned))
  retained_pct = IF(period.idx < cohort.idx, BLANK, IFERROR(active / starting, BLANK))
" }

finicast_query { model: "retention", table: "retention", rows: ["cohort"], cols: ["period"], pages: { line: "active" }, title: "Active customers by cohort" }
finicast_query { model: "retention", table: "retention", rows: ["cohort"], cols: ["period"], pages: { line: "retained_pct" }, title: "Retention" }
finicast_share { model: "retention" }
```

```
| cohort | Jan-26 | Feb-26 | Mar-26 | Apr-26 | May-26 | Jun-26 |
|--------|-------:|-------:|-------:|-------:|-------:|-------:|
| jan26  |      3 |      3 |      2 |      1 |      1 |      1 |
| feb26  |        |      2 |      2 |      2 |      1 |      1 |
| mar26  |        |        |      3 |      3 |      3 |      2 |
```

Count rows by id with `COUNTD(table.id)` (ids are unique; `COUNT` counts numbers only). Revenue
retention: load an `mrr` column and use `SUM(customers.mrr[...])` in place of `COUNTD`.

---

## 5. Territory scoring and quota

Activities score through a lookup (`activity_type.points`), roll up to territory × quarter through
two reference hops (`activities.rep → reps.territory`), and quota is allocated by share of points.

```
finicast_create_model { model: "salesops" }

finicast_load_table { model: "salesops", table: "territories", source: { inline: [{ id: "west" }, { id: "east" }] } }
finicast_load_table { model: "salesops", table: "reps", source: { csv: "id,territory\nr1,west\nr2,west\nr3,east" } }
finicast_load_table { model: "salesops", table: "activity_types", source: { csv: "id,points\ncall,1\nmeeting,3\ndemo,5" } }
finicast_load_table { model: "salesops", table: "ts_lines",
  source: { inline: [{ id: "points" }, { id: "quota_share" }, { id: "quota" }] } }

finicast_define_pivot { model: "salesops", table: "territory_scores", lineDim: "line", timeDim: "period",
  dims: [{ id: "territory", from: "territories" }, { id: "line", from: "ts_lines" },
         { id: "period", from: { periods: { start: "2026-01", count: 4, grain: "quarter" } } }] }
  → periods q1_2026 … q4_2026

finicast_load_table { model: "salesops", table: "activities",
  options: { computed: [{ id: "score" }] },
  source: { csv:
"id,rep,activity_type,period
a1,r1,call,q1_2026
a2,r1,demo,q1_2026
a3,r2,meeting,q1_2026
a4,r3,demo,q1_2026
a5,r3,call,q2_2026
a6,r1,meeting,q2_2026" } }
  → rep → reps, activity_type → activity_types, period → periods

finicast_set_rules { model: "salesops", table: "activities", rules: "score = activity_type.points" }

finicast_load_table { model: "salesops", table: "drivers", source: { inline: [{ id: "total_quota" }] } }
finicast_define_pivot { model: "salesops", table: "assumptions", lineDim: "driver",
  dims: [{ id: "driver", from: "drivers" }, { id: "period", from: "periods" }] }
finicast_set_values { model: "salesops", table: "assumptions", values: [
  { at: { driver: "total_quota", period: "q1_2026" }, value: 1000000 }, { at: { driver: "total_quota", period: "q2_2026" }, value: 1000000 },
  { at: { driver: "total_quota", period: "q3_2026" }, value: 1200000 }, { at: { driver: "total_quota", period: "q4_2026" }, value: 1200000 } ] }

finicast_set_rules { model: "salesops", table: "territory_scores", rules: "
  points      = SUM(activities.score)
  quota_share = IFERROR(points / SUM(points[territory=all]), 0)
  quota       = quota_share * assumptions.total_quota
" }

finicast_query { model: "salesops", table: "territory_scores", rows: ["territory", "line"], cols: ["period"], title: "Territory scoring and quota" }
finicast_share { model: "salesops" }
```

Changing one `points` value in `activity_types`, or one activity's rep, updates the pivot
incrementally. If a table reaches a dimension two ways (owner and closer both → reps) the error
`AMBIGUOUS_GROUP_KEY` returns the fix: `SUM(deals.acv[owner=@rep])`.

---

## 6. Tiered commission calculator

Attainment is spread across tranches; each tranche pays its own rate; a `total` member sums the rest.

```
finicast_create_model { model: "comp" }

finicast_load_table { model: "comp", table: "reps", source: { csv: "id,quota,bookings\nalice,500000,650000\nbob,500000,420000" } }
finicast_load_table { model: "comp", table: "tranches", source: { csv:
"id,from_pct,to_pct,rate
t1,0,1,0.08
t2,1,1.5,0.12
t3,1.5,99,0.16
total,,," } }
finicast_load_table { model: "comp", table: "comm_lines",
  source: { inline: [{ id: "attainment" }, { id: "in_tranche" }, { id: "commission" }] } }

finicast_define_pivot { model: "comp", table: "commissions", lineDim: "line",
  dims: [{ id: "rep", from: "reps" }, { id: "tranche", from: "tranches" }, { id: "line", from: "comm_lines" }] }

finicast_set_rules { model: "comp", table: "commissions", rules: "
  attainment                = rep.bookings / rep.quota
  in_tranche                = IF(attainment <= tranche.from_pct, 0, IF(attainment >= tranche.to_pct, tranche.to_pct - tranche.from_pct, attainment - tranche.from_pct))
  commission                = in_tranche * rep.quota * tranche.rate
  in_tranche[tranche=total] = SUM(in_tranche[tranche != total])
  commission[tranche=total] = SUM(commission[tranche != total])
" }

finicast_query { model: "comp", table: "commissions", rows: ["rep", "tranche"], cols: ["line"], title: "Commissions" }
finicast_share { model: "comp" }
```

alice: 130% attainment → t1 100% × 500,000 × 8% = 40,000; t2 30% × 500,000 × 12% = 18,000; total 58,000.
Per-period commissions: add a `period` dim and read bookings from a bookings table with
`SUM(bookings.acv[rep=@rep])`.

---

## 7. Period tables

Generated by `finicast_define_pivot` with `from: { periods: { start, count, grain, histUntil } }`,
or reused across pivots with `from: "periods"`. Attributes on every member:

| attribute | example (month / quarter / year) | use in rules |
|---|---|---|
| `id` | `jan26` / `q1_2026` / `fy2026` | `[period=jan26]`, `at: { period: "fy2026" }` |
| `name` | `Jan-26` / `Q1 2026` / `FY2026` | column headers |
| `frame` | `hist` or `fcst` (from `histUntil`) | `revenue[frame=fcst] = …`; query suffixes `E` on fcst columns |
| `year` | `2026` | `[period.year >= 2027]` |
| `quarter` | `Q1 2026` | `SUM(value[period.quarter = "Q1 2026"])` |
| `idx` | `0, 1, 2, …` | `period.idx >= hire.start_period.idx` |
| `start`, `end` | dates | `PERIOD(date, periods)` maps a date into the table |

Move the actual/forecast boundary later with `finicast_set_values { table: "periods", rows: [{ id: "fy2026", frame: "fcst" }] }`
— every rule conditioned on `frame` re-dispatches.
