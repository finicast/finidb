# FiniDB formula language — condensed (from design doc 04)

## 1. A rule

```
<target>[<condition>] = <expression>          // one rule per line; // comments allowed
revenue[frame=fcst]  = PREV(revenue) * (1 + assumptions.growth)
gross_profit         = revenue - cogs
```

- `target` is a **line item** (a member of the pivot's line dimension, read on the default measure
  `value`), a **measure**, or a **field** of a tabular table.
- `[condition]` restricts where the rule applies: dims, attributes (`frame=fcst`,
  `period.year >= 2027`), member sets (`line in (a, b)`), fields (tabular). Not computed values —
  put those tests inside `IF`.
- **Last matching rule wins; an input (set_values) beats every rule.** General rule first,
  override below.
- Structured form (also accepted by `finicast_set_rules`):
  `{ target: "value", when: [{ left: "line", op: "=", right: "revenue" }, { left: "period.frame", op: "=", right: "fcst" }], formula: "PREV(revenue) * (1 + growth)" }`

## 2. Lexical

| Thing | Form |
|---|---|
| identifier | `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive; function names case-insensitive |
| quoted name | `'Gross Profit'` — a name or id with spaces/punctuation |
| string | `"text"` (never resolved as a name) |
| number | `1000`, `0.35`, `1e6`, `12%` (= 0.12) |
| literals | `TRUE`, `FALSE`, `BLANK` |
| comments | `// line`, `/* block */` |
| operators (low → high) | `or`; `and`; `not`; `= != < <= > >=`; `+ - &`; `* /`; `^`; unary `-` (`&&`, `\|\|`, `<>` accepted) |

Convention: ids are snake_case and formulas use ids. Names are for humans.

## 3. References — one syntax

```
[table.]name[selector, …][.attribute…]
```

**Bare name in a pivot rule** resolves, in order, to: a measure (`value`) → a line item
(`revenue` = `value[line=revenue]`) → an attribute of a dimension, if unique (`frame`, else write
`period.frame`) → a dimension (its current member id). In a **tabular** rule a bare name is a field
of the current row. Ambiguity is a compile error naming the qualified spellings.

**Qualified**: `assumptions.growth` (line item of another pivot), `comm_calc.value[tranche=total]`
(measure of another pivot, pinned), `financials.amount` (a **column** of a table → a set; must be
aggregated), `salesops.periods.frame` (cross-model).

**Selectors** (comma = AND):

| Form | Meaning | Example |
|---|---|---|
| `dim = member` | pin | `value[tranche=total]` |
| `dim != m`, `dim in (a,b)`, `dim not in (a,b)` | member set (inside an aggregate) | `SUM(value[tranche != total])` |
| `dim - n`, `dim + n` | offset (blank out of range) | `revenue[period-1]` |
| `dim = first`, `dim = last`, `dim = this` | positional | `value[period=first]` |
| `dim = a .. b` | inclusive range (`first`, `last`, `this±n`, member) | `SUM(value[period=first..this])`, `SUM(value[line=sales..ga])` |
| `dim = all` | every member (explicit marginal) | `SUM(points[territory=all])` |
| `dim.attr = lit`, `dim.attr in (…)`, `dim.attr < lit` | attribute test | `SUM(value[line.category=opex])`, `value[period.year >= 2027]` |
| `dim = @other`, `dim.attr = @other`, `dim = @other.attr` | correlation to the current cell | `SUM(goal[region.parent=@region])`, `value[region=@region.parent]` |
| tabular source: `field = literal`, `field = @dim`, `path.through.refs = @dim` | row filter / group key | `SUM(deals.acv[owner=@rep])`, `SUM(activities.score[rep.territory=@territory])` |

Dimensions of a referenced pivot **not mentioned** default to the current member when this pivot has
a dim over the same table, to `all` inside an aggregate, else a compile error asking for a pin.
That is why `revenue[period-1]` and `SUM(detail.value)` are short. Consequence: give each dimension
of a pivot its own member table (a `cohorts` table next to `periods`), never two dims over one table.

**Scalar vs set**: a reference is scalar when every source dimension is fixed to one member
(default, pin, offset, correlation). Otherwise it is a set and must sit directly inside an aggregate:
`financials.amount` → `SUM(financials.amount)`; `value[tranche != total]` → `SUM(...)`.

**`@`**: `@dim` is the current cell's member; `@dim.attr` its attribute; `@field` the current row's
field in a tabular rule. `period.frame` is shorthand for `@period.frame`.

**Paths through refs**: `activity_type.points` (row → referenced row → field), `rep.territory.name`
(two hops), `period.frame`, `hire.start_period.idx` (dim member → ref → attribute).

**Time sugar** (pivot with `timeDim`): `PREV(x)` = `x[time-1]`, `NEXT(x)`, `PREV(x, 12)`,
`FIRST(x)`, `LAST(x)`, `CUMSUM(x)` = `SUM(x[time=first..this])`, `TRAILING(x, n, AVG)`.

**Tabular rows**: `balance[row-1] + amount` (running total), `x[row+1]`, `x[row=first]`,
`SUM(x[row=first..this])`.

## 4. Aggregates

`SUM AVG COUNT COUNTA COUNTD MIN MAX FIRST LAST MEDIAN LISTAGG` — each takes **one set reference**
(`COUNT` counts numbers, Excel-style; count rows by a text id with `COUNTD(customers.id)`):

- **Marginal over a pivot**: `SUM(detail.value)`, `SUM(value[tranche != total])`, `SUM(hire_plan.active)`
  — sums over the dims the target does not fix; masks on the collapsed dim are cheap.
- **Group-by over a table**: `SUM(activities.score)` — each row maps to a target coordinate through
  declared refs (`activities.rep → reps.territory`, `activities.period`) or explicit `field=@dim`.
  A text column with a `distinctOf` dimension needs the explicit form: `SUM(ledger.amount[cost_center=@cost_center])`.
  Two ref paths to the same dim → `AMBIGUOUS_GROUP_KEY` with a fix.
- **Range along one dim**: `SUM(x[period=first..this])`.

No general `SELECT`; anything else is rejected with the nearest legal form.

## 5. Functions

- Logic: `IF AND OR NOT IFERROR ISBLANK ISNUMBER ISTEXT COALESCE`
- Math: `ABS ROUND ROUNDUP ROUNDDOWN MROUND TRUNC MOD POWER SQRT EXP LN LOG LOG10 SIGN`
- Text: `CONCAT LEFT RIGHT MID LEN LOWER UPPER TRIM REPLACE SUBSTITUTE CONTAINS STARTSWITH ENDSWITH TEXT VALUE`, `&`
- Dates: `DATE TODAY YEAR MONTH DAY QUARTER WEEKDAY DAYS DATEDIF EOMONTH SOMONTH NETWORKDAYS YEARFRAC`
- Finance: `PMT PPMT IPMT PV FV NPV IRR RATE NPER SLN SYD DB DDB`
- Planning: `PERIOD(date, periods)` maps a date to a member of a periods table (use as a computed
  ref field: `period = PERIOD(date, periods)`); `PREV NEXT CUMSUM TRAILING`; `GROWTH(base, rate, n)`; `BLANK`.

`MIN`/`MAX` are aggregates over one set — for a scalar clamp write `IF(x > cap, cap, x)`.

## 6. Idioms

```
revenue[frame=hist]        = SUM(financials.amount[account=revenue])    // actuals from a ledger
revenue[frame=fcst]        = PREV(revenue) * (1 + assumptions.growth)   // driver recurrence
opex                       = SUM(value[line.category = opex])           // subtotal by attribute
total[tranche=total]       = SUM(value[tranche != total])               // subtotal by mask
sum_of_subs                = SUM(goal[region.parent = @region])         // children roll-up
topdown                    = topdown[region=@region.parent] * region.pct_of_parent   // parent allocation
points                     = SUM(activities.score)                      // group-by through refs
bookings                   = SUM(deals.acv[owner=@rep])                 // explicit group key
ending_arr                 = SUM(customer_data.arr[customer.geo = @geo])// pivot → pivot through a ref attribute
share                      = points / SUM(points[territory=all])        // share of total
active                     = IF(period.idx >= hire.start_period.idx, 1, 0)   // attribute comparisons
cum_ni                     = CUMSUM(net_income)                          // running sum over time
score                      = activity_type.points                        // tabular: follow a ref
balance                    = balance[row-1] + amount                     // tabular running total
period                     = PERIOD(date, periods)                       // tabular: date → period ref
acct_total                 = acct.total[account=@account]                // tabular reads a pivot
email                      = "x+" & SUBSTITUTE(id, " ", "") & "@co.com"  // text
```

## 7. Errors

Strict mode (default) rejects the batch; each error carries `code`, `message` and, when possible,
`fix` — a fragment to apply verbatim. Runtime cell errors (`DIV0`, `REF`, `TYPE`, `CYCLE`) render as
`#CODE` in the grid and propagate to dependents. See `errors.md`.
