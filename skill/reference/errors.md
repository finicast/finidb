# FiniDB error codes

Every tool failure is `{ ok: false, errors: [{ code, message, fix? }] }`. In strict mode (the default
for `finicast_set_rules`) the whole batch is rejected and the table keeps its previous rules — fix
the rule and **resend the full batch**. When `fix` is present, apply it verbatim.

## Rule compile errors (finicast_set_rules)

| Code | Meaning | What to do |
|---|---|---|
| `PARSE` | The rule text does not parse (`Expected '=' but found …`, `'x' is a keyword`). | One rule per line, `target[condition] = expression`. Quote names with spaces: `'Gross Profit'`. Strings in double quotes. |
| `UNKNOWN_TARGET` | The left side is not a measure or line item of the pivot (or a field of the table). | Use an id from `finicast_schema`; add the line item to the line table first (`finicast_set_values { rows: [{ id: "new_line" }] }`) or the computed field at load time (`options.computed`). |
| `UNKNOWN_NAME` | A name in the expression is not a measure, line item, dimension or attribute of this pivot (or a field of this table). | Check spelling and case against `finicast_schema`. Other tables need a qualifier: `assumptions.growth`, `financials.amount`. |
| `AMBIGUOUS_ATTRIBUTE` | A bare attribute exists on two dimensions (`idx` on both `cohort` and `period`). | Qualify it: `period.idx`, `cohort.idx`. |
| `AMBIGUOUS_GROUP_KEY` | A table can reach one of the pivot's dimensions through two reference paths (`deals.owner → reps`, `deals.closer → reps`). | Apply the fix: `SUM(deals.acv[owner=@rep])`. |
| `SET_IN_SCALAR` | A reference denotes many cells/rows where one value is needed (`financials.amount`, `value[tranche != total]`). | Wrap it in an aggregate — `SUM(financials.amount)` — or pin every dimension. |
| `UNPINNED_DIM` | A reference to another pivot leaves a dimension this pivot does not share. | Pin it: `comm_calc.value[tranche=total]`, or put the reference inside an aggregate to sum over it. |
| `NO_CURRENT` | A selector uses `this`/an offset on a dimension that has no current member in this context. | Pin the dimension explicitly. |
| `UNKNOWN_DIM` | `@name` or a selector names a dimension the pivot does not have. | Use the dim ids shown by `finicast_schema` (`@territory`, `[period-1]`). |
| `NO_MEMBER` | A pinned member does not exist (`[tranche=totl]`). | Use a member id (or name) from the dimension's table. |
| `BAD_PATH` | A dot follows a field that is not a reference (`amount.x`). | Only ref fields and dimensions can be followed: `activity_type.points`, `rep.territory.name`. |
| `BAD_REF` | A dimension name carries a selector (`period[…]`). | Selectors go on the value: `value[period-1]`, `revenue[period=first]`. |
| `BAD_SELECTOR` | Illegal selector form: a keyword on a table field, a range on a table field, `[row±n]` outside the table, an attribute test against a non-literal. | Tables use `[field=literal]`, `[field=@dim]`, `[row-1]`, `[row=first..this]`. |
| `BAD_CONDITION` | The rule's `[condition]` uses a form only valid in expressions (`first`, `all`, offsets, ranges). | Conditions take members, member sets and attribute tests: `[frame=fcst]`, `[line in (a, b)]`, `[period.year >= 2027]`. |
| `BAD_ARG` | Wrong argument kind: `PREV(1 + x)`, `PERIOD(date, not_a_table)`. | `PREV/NEXT/FIRST/LAST/CUMSUM/TRAILING` take a reference; `PERIOD(date, periods)` names a periods table. |
| `NO_TIME_DIM` | `PREV/NEXT/CUMSUM/TRAILING` used on a pivot without a time dimension (or in a table rule). | Set `timeDim` in `finicast_define_pivot`, or write the offset explicitly: `x[period-1]`. |
| `NO_PERIODS` | `PERIOD(date)` could not find a periods table with `start`/`end`. | Pass it: `PERIOD(date, periods)`. |
| `UNKNOWN_FUNCTION` | Function name not in the library (`SELECT`, `PTHIS`, `VLOOKUP`). | See `syntax.md` §5; legacy `SELECT(...)` becomes a plain reference with selectors. |
| `RULE_INVALID` | Non-strict mode: the rule was stored but marked invalid (the message says why). | Fix and resend; invalid rules are skipped when evaluating. |

## Runtime cell errors (shown as `#CODE` in query output; `finicast_explain` gives the message)

| Code | Meaning | What to do |
|---|---|---|
| `DIV0` | Division by zero. | `IFERROR(a / b, BLANK)` or `IF(b = 0, BLANK, a / b)`. |
| `TYPE` | A function got the wrong value type (text where a number or date was expected), e.g. `COUNT(customers.id)` or `COUNTA(customers.id)` on text ids. | Use `COUNTD(table.id)` to count rows by id; check the column's inferred type in the load profile and force it with `options.types`. |
| `NUM` | Numeric domain error (`SQRT(-1)`, `LN(0)`). | Guard with `IF`. |
| `REF` | A path could not be followed: missing referenced row, a value that is not a member, a path on a non-reference. | Check the referenced table has the row; use `PERIOD(date, periods)` for dates. |
| `OP` | Unsupported operator/operand combination. | Use the operators in `syntax.md` §2. |
| `CYCLE` | The cell depends on itself (`a = b`, `b = a`, or a `[row-1]` chain that loops). | Break the cycle; a running total reads the previous row/period, not the same one. |

## Schema, data and query errors (any tool)

| Code | Meaning | What to do |
|---|---|---|
| `SCHEMA_NO_MODEL` | Model id does not exist. | `finicast_schema`, then `finicast_create_model`. |
| `SCHEMA_NO_TABLE` | Table or pivot id does not exist in the model. | Use ids from `finicast_schema`. |
| `SCHEMA_DUPLICATE_MODEL` / `SCHEMA_DUPLICATE_TABLE` | Id already used. | Pick another id, or reuse the existing object (`from: "periods"`). |
| `SCHEMA_DUPLICATE_FIELD` / `SCHEMA_DUPLICATE_DIM` / `SCHEMA_DUPLICATE_MEASURE` | Id already used within the table/pivot. | Rename. |
| `SCHEMA_NO_FIELD` | Field id does not exist. | Check the load profile; ids are slugged (`Cost Center` → `cost_center`). |
| `SCHEMA_REF_NOT_TABULAR` | A `ref` targets a pivot. | References point at tables (dimension tables), not pivots. |
| `SCHEMA_NO_MEASURE` | The pivot has no measure or the named measure is missing. | Measures default to `[{ id: "value" }]`. |
| `DATA_DUPLICATE_ID` | Two rows share an id. | Set `options.idColumn` to a unique column or omit it to generate ids. |
| `DATA_UNKNOWN_REF` | A reference value is not an id of the target table (`period = "FY24"` when ids are `fy2024`). | Load/generate the dimension first; match ids exactly; or drop the forced `refs` entry. |
| `DATA_NO_ROW` | Row id not found (`set_values`, `explain`). | Check ids with `finicast_explain { at: { id } }` or reload. |
| `COORD_MISSING_DIM` | `at` lacks one of the pivot's dimensions. | Give every dim: `{ line, period }`. |
| `COORD_NO_MEMBER` | `at` names a member that does not exist. | Use member ids from the dimension table. |
| `QUERY_UNPINNED_DIM` | A dim is on neither `rows`, `cols` nor `pages`. | Add it to `pages: { dim: member }`. |
| `NOT_A_PIVOT` | `finicast_query` on a tabular table. | Query pivots; read table rows with `finicast_explain { at: { id }, measure: field }`. |
| `BAD_SOURCE` / `BAD_DIM` / `BAD_ARG` | Malformed tool arguments (no `csv`/`inline`, `distinctOf` without `table.field`, `values` on a table). | See the tool's description. |

## Response cap

`finicast_query` truncates rows beyond `maxRows` (`… N more rows`) and caps a response at ~4,000
tokens, appending `[response capped …]`. Narrow with `filters`, `pages`, `maxRows` or `scale`.
