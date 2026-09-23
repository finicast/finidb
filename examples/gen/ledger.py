#!/usr/bin/env python3
"""Generates examples/ledger-to-model.json: a general ledger becomes a monthly operating plan.

Meridian Software, FY2026, two entities (US, UK), six departments, twelve accounts. The ledger is a CSV in the
document (about 750 journal lines, January to August); PERIOD(date) maps each line to its month. Actual months
come from the ledger; forecast months come from drivers: revenue growth, hosting and support cost as a share of
revenue, headcount × loaded cost per head for salaries, benefits as a share of salaries, commissions, marketing
programs and cloud as a share of revenue, other opex grown at a rate. A budget (the annual operating plan) sits
beside the outlook, and full-year and year-to-date pivots compare them by entity, department and account, then
roll up into a P&L. Figures are illustrative; the ledger is seeded so the file is reproducible.

Run: python3 examples/gen/ledger.py
"""
import json, math, random, os

rng = random.Random(2026)
MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
PID = [f'{m}26' for m in MON]
HIST = 8   # January to August are actual

SUBS = [('us', 'United States', 1.0), ('uk', 'United Kingdom', 0.42)]
DEPTS = [('company', 'Company (revenue and cost of revenue)'), ('sales', 'Sales'), ('marketing', 'Marketing'), ('engineering', 'Engineering'), ('customer_success', 'Customer success'), ('g_and_a', 'G&A')]
ACCOUNTS = [('revenue', 'Revenue'), ('cogs_hosting', 'Cost of revenue: hosting'), ('cogs_support', 'Cost of revenue: support'), ('salaries', 'Salaries'), ('benefits', 'Benefits and payroll taxes'), ('commissions', 'Commissions'),
            ('contractors', 'Contractors'), ('cloud', 'Cloud and infrastructure'), ('marketing_programs', 'Marketing programs'), ('software', 'Software and tools'), ('travel', 'Travel and events'), ('rent', 'Rent and facilities'), ('professional_fees', 'Professional fees'), ('total', 'Net')]
# heads at January (US), annual loaded cost per head (US, $), other monthly opex per department (US, $) by account
HEADS = dict(sales=22, marketing=9, engineering=38, customer_success=12, g_and_a=10)
HIRES = dict(sales=[0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1], marketing=[0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0], engineering=[1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 1], customer_success=[0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0], g_and_a=[0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0])
COST = dict(sales=165000, marketing=140000, engineering=190000, customer_success=110000, g_and_a=150000)
OTHER = {   # monthly, US, January level
    'sales': dict(travel=38000, software=9000), 'marketing': dict(software=14000, travel=12000), 'engineering': dict(contractors=62000, software=21000),
    'customer_success': dict(software=7000, travel=4000), 'g_and_a': dict(rent=88000, professional_fees=34000, software=11000, travel=6000)}
REV0 = 4_150_000   # US January revenue
# the plan the year was budgeted on (AOP) versus what happened (actual drivers)
AOP = dict(revenue_growth=0.024, hosting_pct=0.11, support_pct=0.05, benefits_pct=0.21, commission_pct=0.045, marketing_pct=0.08, cloud_pct=0.075, other_growth=0.004)
ACT = dict(revenue_growth=0.019, hosting_pct=0.118, support_pct=0.051, benefits_pct=0.214, commission_pct=0.047, marketing_pct=0.083, cloud_pct=0.089, other_growth=0.006)
SEASON = [0.97, 0.98, 1.03, 1.0, 1.0, 1.04, 0.98, 0.97, 1.02, 1.01, 1.0, 1.06]

def series(drv, scale, heads_by_dept):
    """Expected monthly amounts per (sub, dept, account) for one driver set: revenue path, cost shares, headcount costs."""
    out = {}
    rev = [REV0 * scale * (1 + drv['revenue_growth']) ** i * SEASON[i] for i in range(12)]
    for i in range(12):
        out[('company', 'revenue', i)] = rev[i]
        out[('company', 'cogs_hosting', i)] = -rev[i] * drv['hosting_pct']
        out[('company', 'cogs_support', i)] = -rev[i] * drv['support_pct']
        for d in HEADS:
            sal = -heads_by_dept[d][i] * COST[d] * (0.85 if scale < 1 else 1.0) / 12
            out[(d, 'salaries', i)] = sal
            out[(d, 'benefits', i)] = sal * drv['benefits_pct']
            for acct, amt in OTHER[d].items(): out[(d, acct, i)] = -amt * scale * (1 + drv['other_growth']) ** i
        out[('sales', 'commissions', i)] = -rev[i] * drv['commission_pct']
        out[('marketing', 'marketing_programs', i)] = -rev[i] * drv['marketing_pct']
        out[('engineering', 'cloud', i)] = -rev[i] * drv['cloud_pct']
    return out

def heads_path(scale, plan):
    """Headcount by department and month: January heads plus hires; the plan hires a little faster."""
    out = {}
    for d, h0 in HEADS.items():
        h = round(h0 * scale); path = []
        for i in range(12):
            h += HIRES[d][i] * (1 if scale == 1.0 else (1 if i % 2 == 0 else 0)) + (1 if plan and i in (2, 8) and d in ('engineering', 'sales') else 0)
            path.append(h)
        out[d] = path
    return out

ledger_rows, budget_values, head_values = [], [], []
n = 0
for sub, _, scale in SUBS:
    heads_act, heads_plan = heads_path(scale, False), heads_path(scale, True)
    exp_act, exp_aop = series(ACT, scale, heads_act), series(AOP, scale, heads_plan)
    for (dept, acct, i), amt in exp_aop.items():
        budget_values.append(dict(at=dict(subsidiary=sub, department=dept, line=acct, period=PID[i]), value=round(amt, -2)))
    for d in HEADS:
        for i in range(12):
            head_values.append(dict(at=dict(subsidiary=sub, department=d, line='heads', period=PID[i]), value=heads_act[d][i] if i < HIST else heads_plan[d][i]))
            head_values.append(dict(at=dict(subsidiary=sub, department=d, line='cost_per_head', period=PID[i]), value=round(COST[d] * (0.85 if scale < 1 else 1.0), -3)))
    for (dept, acct, i), amt in exp_act.items():
        if i >= HIST: continue
        actual = amt * math.exp(rng.gauss(0, 0.05 if acct != 'revenue' else 0.03))
        k = 1 if acct in ('salaries', 'benefits', 'rent') else rng.choice([1, 2, 2, 3])
        parts = [rng.random() + 0.3 for _ in range(k)]; tot = sum(parts)
        for p in parts:
            n += 1
            day = rng.choice([5, 12, 15, 20, 28]) if acct != 'salaries' else 25
            ledger_rows.append(f'j{n:05d},2026-{i + 1:02d}-{day:02d},{sub},{dept},{acct},{round(actual * p / tot):.0f}')
csv = 'id,date,subsidiary,department,account,amount\n' + '\n'.join(ledger_rows) + '\n'

def L(id, name, fmt=None):
    d = {'id': id, 'name': name}
    if fmt: d['format'] = fmt
    return d
PCT = 'percent'
PLAN = [('revenue_growth', 'Revenue growth per month', PCT, ACT['revenue_growth']), ('hosting_pct', 'Hosting cost, % of revenue', PCT, ACT['hosting_pct']), ('support_pct', 'Support cost, % of revenue', PCT, ACT['support_pct']),
        ('benefits_pct', 'Benefits, % of salaries', PCT, ACT['benefits_pct']), ('commission_pct', 'Commissions, % of revenue', PCT, ACT['commission_pct']), ('marketing_pct', 'Marketing programs, % of revenue', PCT, ACT['marketing_pct']),
        ('cloud_pct', 'Cloud, % of revenue', PCT, ACT['cloud_pct']), ('other_growth', 'Other opex growth per month', PCT, ACT['other_growth'])]
PNL = [L('revenue', 'Revenue'), L('cost_of_revenue', 'Cost of revenue'), L('gross_profit', 'Gross profit'), L('gross_margin', 'Gross margin', PCT),
       L('opex_sales', 'Sales'), L('opex_marketing', 'Marketing'), L('opex_engineering', 'Engineering'), L('opex_customer_success', 'Customer success'), L('opex_g_and_a', 'G&A'),
       L('total_opex', 'Total operating expenses'), L('ebitda', 'EBITDA'), L('ebitda_margin', 'EBITDA margin', PCT), L('heads', 'Headcount (period end)')]
VERSIONS = [('ytd_actual', 'YTD actual'), ('ytd_budget', 'YTD budget'), ('ytd_variance', 'YTD variance'), ('fy_outlook', 'FY outlook'), ('fy_budget', 'FY budget'), ('fy_variance', 'FY variance'), ('fy_variance_pct', 'FY variance %')]
OPEX_DEPTS = ['sales', 'marketing', 'engineering', 'customer_success', 'g_and_a']

pnl_rules = ['revenue = model.revenue[department=company]', 'cost_of_revenue = SUM(model.value[department=company, line in (cogs_hosting, cogs_support)])', 'gross_profit = revenue + cost_of_revenue', 'gross_margin = IFERROR(gross_profit / revenue, BLANK)'] + \
            [f'opex_{d} = SUM(model.value[department={d}, line != total])' for d in OPEX_DEPTS] + \
            ['total_opex = ' + ' + '.join(f'opex_{d}' for d in OPEX_DEPTS), 'ebitda = gross_profit + total_opex', 'ebitda_margin = IFERROR(ebitda / revenue, BLANK)', 'heads = SUM(headcount.heads)']
fy_summary_rules = ['revenue = SUM(fy.value[department=company, line=revenue])', 'cost_of_revenue = SUM(fy.value[department=company, line in (cogs_hosting, cogs_support)])', 'gross_profit = revenue + cost_of_revenue'] + \
            [f'opex_{d} = SUM(fy.value[department={d}, line != total])' for d in OPEX_DEPTS] + \
            ['total_opex = ' + ' + '.join(f'opex_{d}' for d in OPEX_DEPTS), 'ebitda = gross_profit + total_opex',
             # the variance % column is a ratio of this pivot's own totals, never a sum of the accounts' percentages
             'value[version=fy_variance_pct] = IFERROR(value[version=fy_variance] / ABS(value[version=fy_budget]), BLANK)',
             'gross_margin = IFERROR(gross_profit / revenue, BLANK)', 'ebitda_margin = IFERROR(ebitda / revenue, BLANK)',
             'gross_margin[version=ytd_variance] = gross_margin[version=ytd_actual] - gross_margin[version=ytd_budget]', 'gross_margin[version=fy_variance] = gross_margin[version=fy_outlook] - gross_margin[version=fy_budget]',
             'ebitda_margin[version=ytd_variance] = ebitda_margin[version=ytd_actual] - ebitda_margin[version=ytd_budget]', 'ebitda_margin[version=fy_variance] = ebitda_margin[version=fy_outlook] - ebitda_margin[version=fy_budget]',
             'gross_margin[version=fy_variance_pct] = BLANK', 'ebitda_margin[version=fy_variance_pct] = BLANK',
             'heads = BLANK', 'heads[version=ytd_actual] = SUM(fy.heads_end)', 'heads[version=fy_outlook] = SUM(fy.heads_end)']

doc = {
  'model': 'ledger', 'name': 'Meridian Software — FY2026 operating plan from the ledger', 'units': 'USD',
  'periods': {'start': '2026-01', 'count': 12, 'grain': 'month', 'histUntil': '2026-08-31'},
  'tables': {
    'ledger': {'name': 'General ledger (journal lines)', 'csv': csv, 'fields': {'period': 'ref:periods*'}, 'rules': 'period = PERIOD(date, periods)'},
    'subsidiaries': {'name': 'Entities', 'rows': [dict(id=i, name=n) for i, n, _ in SUBS]},
    'departments': {'name': 'Departments', 'rows': [dict(id=i, name=n) for i, n in DEPTS]},
    'accounts': {'name': 'Accounts', 'rows': [dict(id=i, name=n) for i, n in ACCOUNTS]},
    'versions': {'name': 'Versions', 'rows': [dict(id=i, name=n, **({'format': 'percent'} if i == 'fy_variance_pct' else {})) for i, n in VERSIONS]},
  },
  'pivots': {
    'plan': {'name': 'Forecast drivers', 'lines': [L(i, n, f) for i, n, f, _ in PLAN],
      'values': [dict(at=dict(line=i, period=p), value=v) for i, _, _, v in PLAN for p in PID[HIST:]]},
    'headcount': {'name': 'Headcount plan', 'dims': {'subsidiary': 'subsidiaries', 'department': 'departments'},
      'lines': [L('heads', 'Heads (period end)'), L('cost_per_head', 'Loaded cost per head, annual'), L('salary_cost', 'Salary cost (month)')],
      'values': head_values, 'rules': ['salary_cost = -heads * cost_per_head / 12']},
    'model': {'name': 'Outlook: actuals from the ledger, then the forecast', 'dims': {'subsidiary': 'subsidiaries', 'department': 'departments'}, 'lineTable': 'accounts',
      'rules': ['value[frame=hist] = SUM(ledger.amount[subsidiary=@subsidiary, department=@department, account=@line])',
                'value[frame=fcst] = PREV(value) * (1 + plan.other_growth)',
                'revenue[frame=fcst, department=company] = PREV(revenue) * (1 + plan.revenue_growth)',
                'cogs_hosting[frame=fcst, department=company] = -revenue * plan.hosting_pct', 'cogs_support[frame=fcst, department=company] = -revenue * plan.support_pct',
                'salaries[frame=fcst] = headcount.salary_cost', 'benefits[frame=fcst] = salaries * plan.benefits_pct',
                'commissions[frame=fcst, department=sales] = -revenue[department=company] * plan.commission_pct', 'marketing_programs[frame=fcst, department=marketing] = -revenue[department=company] * plan.marketing_pct',
                'cloud[frame=fcst, department=engineering] = -revenue[department=company] * plan.cloud_pct',
                'total = SUM(value[line != total])']},
    'budget': {'name': 'Budget (annual operating plan)', 'dims': {'subsidiary': 'subsidiaries', 'department': 'departments'}, 'lineTable': 'accounts',
      'values': budget_values, 'rules': ['total = SUM(value[line != total])']},
    'pnl': {'name': 'P&L by entity', 'dims': {'subsidiary': 'subsidiaries'}, 'lines': PNL, 'rules': pnl_rules},
    'pnl_company': {'name': 'P&L, company', 'dims': {}, 'lines': PNL,
      'rules': [f'{l["id"]} = SUM(pnl.{l["id"]})' for l in PNL if l['id'] not in ('gross_margin', 'ebitda_margin')] + ['gross_margin = IFERROR(gross_profit / revenue, BLANK)', 'ebitda_margin = IFERROR(ebitda / revenue, BLANK)']},
    'fy': {'name': 'Year to date and full year, by account', 'dims': {'subsidiary': 'subsidiaries', 'department': 'departments', 'version': 'versions', 'period': False}, 'lineTable': 'accounts',
      'measures': ['value', {'id': 'heads_end', 'type': 'number', 'name': 'Heads at period end'}],
      'rules': ['value[version=ytd_actual] = SUM(model.value[period.frame=hist])', 'value[version=ytd_budget] = SUM(budget.value[period.frame=hist])', 'value[version=ytd_variance] = value[version=ytd_actual] - value[version=ytd_budget]',
                'value[version=fy_outlook] = SUM(model.value)', 'value[version=fy_budget] = SUM(budget.value)', 'value[version=fy_variance] = value[version=fy_outlook] - value[version=fy_budget]',
                'value[version=fy_variance_pct] = IFERROR(value[version=fy_variance] / ABS(value[version=fy_budget]), BLANK)',
                'heads_end = BLANK', 'heads_end[line=total, version=ytd_actual] = headcount.heads[period=aug26]', 'heads_end[line=total, version=fy_outlook] = headcount.heads[period=dec26]']},
    'fy_summary': {'name': 'Year to date and full year, P&L', 'dims': {'version': 'versions', 'period': False}, 'lines': PNL, 'rules': fy_summary_rules},
  },
  'outputs': [
    {'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'title': 'P&L by month, company', 'decimals': 0},
    {'pivot': 'fy_summary', 'rows': ['line'], 'cols': ['version'], 'title': 'Year to date and full year', 'decimals': 0},
    {'pivot': 'fy', 'rows': ['subsidiary', 'department'], 'cols': ['version'], 'pages': {'line': 'total'}, 'title': 'Departments: net cost, YTD and full year', 'decimals': 0},
  ],
}

NAV = {'kind': 'links'}
def kpi(pivot, line, title, **kw): return dict(kind='kpi', pivot=pivot, line=line, title=title, **kw)
FY = {'version': ['fy_outlook', 'fy_budget', 'fy_variance', 'fy_variance_pct']}
doc['dashboards'] = [
  {'id': 'outlook', 'name': 'FY2026 outlook', 'theme': 'controller', 'cards': [
    NAV,
    {'kind': 'text', 'title': 'How to read this', 'w': 12, 'h': 2, 'text':
     '**Actuals January to August** come straight from the general ledger (744 entries, two entities, six departments); **September to December** are driven by the forecast drivers on the *Drivers* dashboard: revenue growth, cost of revenue as a share of revenue, headcount times loaded cost, and marketing and cloud as shares of revenue. '
     'The budget is the annual operating plan entered by account and month. Variance is outlook minus budget; a negative number on a cost line is spend above plan. '
     'Click any account on the *Departments* or *Drivers* dashboards to open the ledger entries behind it.'},
    kpi('fy_summary', 'revenue', 'FY2026 revenue: budget → outlook', cols=['version'], filters={'version': ['fy_budget', 'fy_outlook']}, unit='$'),
    kpi('fy_summary', 'ebitda', 'FY2026 EBITDA: budget → outlook', cols=['version'], filters={'version': ['fy_budget', 'fy_outlook']}, unit='$'),
    kpi('fy_summary', 'ebitda_margin', 'FY2026 EBITDA margin: budget → outlook', cols=['version'], filters={'version': ['fy_budget', 'fy_outlook']}),
    kpi('fy_summary', 'revenue', 'YTD revenue: budget → actual', cols=['version'], filters={'version': ['ytd_budget', 'ytd_actual']}, unit='$'),
    {'kind': 'table', 'pivot': 'fy_summary', 'rows': ['line'], 'cols': ['version'], 'title': 'Year to date (January to August) and full year: outlook vs budget'},
    {'kind': 'table', 'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'title': 'P&L by month: actuals through August, forecast from September'},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'lines': ['revenue', 'gross_profit', 'ebitda'], 'title': 'Revenue, gross profit and EBITDA by month', 'w': 6},
    {'kind': 'chart', 'type': 'line', 'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'lines': ['gross_margin', 'ebitda_margin'], 'title': 'Margins by month', 'w': 6},
    {'kind': 'chart', 'type': 'stackedBar', 'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'lines': [f'opex_{d}' for d in OPEX_DEPTS], 'title': 'Operating expenses by department', 'w': 6},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'pnl', 'rows': ['subsidiary'], 'cols': ['period'], 'pages': {'line': 'revenue'}, 'title': 'Revenue by entity', 'w': 6},
  ]},
  {'id': 'departments', 'name': 'Departments and headcount', 'theme': 'controller', 'cards': [
    NAV,
    {'kind': 'table', 'pivot': 'fy', 'rows': ['subsidiary', 'department'], 'cols': ['version'], 'pages': {'line': 'total'}, 'filters': {'department': OPEX_DEPTS}, 'title': 'Department spend: year to date and full year, outlook vs budget'},
    {'kind': 'table', 'pivot': 'fy', 'rows': ['department', 'line'], 'cols': ['version'], 'pages': {'subsidiary': 'us'}, 'filters': {'department': OPEX_DEPTS}, 'hideZeroRows': True, 'title': 'US departments by account: outlook vs budget (click a row for the ledger entries)',
     'drill': {'dashboard': 'ledger', 'params': {'subsidiary': '$page.subsidiary', 'department': '$row.department', 'account': '$row.line'}}},
    {'kind': 'table', 'pivot': 'headcount', 'rows': ['subsidiary', 'department'], 'cols': ['period'], 'pages': {'line': 'heads'}, 'filters': {'department': OPEX_DEPTS}, 'editable': True, 'title': 'Headcount plan (period end; edit September to December)'},
    {'kind': 'chart', 'type': 'stackedBar', 'pivot': 'headcount', 'rows': ['department'], 'cols': ['period'], 'pages': {'line': 'heads', 'subsidiary': 'us'}, 'filters': {'department': OPEX_DEPTS}, 'title': 'US headcount by department', 'w': 6},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'pnl_company', 'rows': ['line'], 'cols': ['period'], 'lines': ['heads'], 'title': 'Company headcount by month', 'w': 6},
  ]},
  {'id': 'drivers', 'name': 'Drivers, budget and ledger', 'theme': 'controller', 'cards': [
    NAV,
    {'kind': 'table', 'pivot': 'plan', 'rows': ['line'], 'cols': ['period'], 'periods': PID[HIST:], 'editable': True, 'title': 'Forecast drivers, September to December (edit any cell)'},
    {'kind': 'table', 'pivot': 'headcount', 'rows': ['subsidiary', 'department'], 'cols': ['period'], 'pages': {'line': 'cost_per_head'}, 'periods': PID[HIST:], 'filters': {'department': OPEX_DEPTS}, 'editable': True, 'title': 'Loaded cost per head, annual (edit any cell)'},
    {'kind': 'table', 'pivot': 'model', 'rows': ['subsidiary', 'department', 'line'], 'cols': ['period'], 'periods': PID[HIST - 3:HIST + 2], 'hideZeroRows': True, 'title': 'Outlook by account: last three actual months and the first two forecast months (click a cell for the ledger entries)',
     'drill': {'dashboard': 'ledger', 'params': {'subsidiary': '$row.subsidiary', 'department': '$row.department', 'account': '$row.line', 'period': '$col'}}},
    {'kind': 'table', 'pivot': 'budget', 'rows': ['subsidiary', 'department', 'line'], 'cols': ['period'], 'periods': PID[HIST - 3:HIST + 2], 'editable': True, 'hideZeroRows': True, 'title': 'Budget by account (edit any cell)'},
  ]},
  {'id': 'ledger', 'name': 'Ledger entries', 'theme': 'controller',
   'params': [{'id': 'subsidiary', 'label': 'Entity'}, {'id': 'department', 'label': 'Department'}, {'id': 'account', 'label': 'Account'}, {'id': 'period', 'label': 'Month'}],
   'cards': [
    NAV,
    {'kind': 'text', 'w': 12, 'h': 1, 'text': 'Entries for **$account** · **$department** · **$subsidiary** · **$period**. Clear a chip above to widen the view; every filter, sort and search below is part of the link.'},
    {'kind': 'data', 'table': 'ledger', 'title': 'General ledger: the entries behind the numbers (filter, sort and search; the view is a link)',
     'fields': ['date', 'subsidiary', 'department', 'account', 'amount', 'period'],
     'where': {'subsidiary': '$subsidiary', 'department': '$department', 'account': '$account', 'period': '$period'}, 'sort': '-date', 'limit': 200, 'h': 10},
  ]},
]

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ledger-to-model.json')
with open(out, 'w') as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out), f'{os.path.getsize(out) / 1024:.0f} KB; ledger lines {len(ledger_rows)}; budget values {len(budget_values)}')
