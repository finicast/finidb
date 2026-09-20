#!/usr/bin/env python3
"""Generates examples/dcf.json: a DCF the way an M&A banker lays it out for a client.

Helix Software (the same illustrative subject as the precedents recipe): five years of unlevered free cash flow
from editable operating drivers, mid-year discounting, a WACC build-up (risk-free rate, beta, equity risk premium,
cost of debt, capital structure), a terminal value by both the perpetuity-growth and the exit-multiple method with
the implied cross-checks, the bridge from enterprise value to equity value and price per share, and two sensitivity
tables of price per share: WACC × terminal growth and WACC × exit multiple. Figures are illustrative.

Run: python3 examples/gen/dcf.py
"""
import json, os

YEARS = ['fy2025', 'fy2026', 'fy2027', 'fy2028', 'fy2029', 'fy2030']
FCST = YEARS[1:]

def L(id, name, fmt=None):
    d = {'id': id, 'name': name}
    if fmt: d['format'] = fmt
    return d
PCT = 'percent'
def by_year(vals): return dict(zip(FCST, vals))

DRIVERS = {
    'revenue_growth': by_year([0.20, 0.18, 0.16, 0.14, 0.12]),
    'ebitda_margin': by_year([0.28, 0.30, 0.32, 0.33, 0.34]),
    'da_pct': by_year([0.035] * 5),
    'capex_pct': by_year([0.045] * 5),
    'nwc_pct': by_year([0.10] * 5),
    'tax_rate': by_year([0.25] * 5),
}
WACC = [('risk_free', 'Risk-free rate', PCT, 0.042), ('beta', 'Levered beta', None, 1.15), ('erp', 'Equity risk premium', PCT, 0.045), ('cost_of_equity', 'Cost of equity', PCT, None),
        ('pre_tax_cost_of_debt', 'Pre-tax cost of debt', PCT, 0.055), ('tax_rate', 'Tax rate', PCT, 0.25), ('after_tax_cost_of_debt', 'After-tax cost of debt', PCT, None),
        ('debt_weight', 'Debt / (debt + equity)', PCT, 0.15), ('equity_weight', 'Equity / (debt + equity)', PCT, None), ('wacc', 'WACC', PCT, None),
        ('terminal_growth', 'Terminal growth rate', PCT, 0.035), ('exit_multiple', 'Exit multiple, EV / EBITDA (x)', None, 16.0),
        ('net_debt', 'Net debt'), ('shares', 'Diluted shares (M)'), ('current_price', 'Current share price ($)')]
WACC_VALUES = dict(net_debt=200, shares=60, current_price=58.0)
CASES = {
    'wacc_cases': [('w_m100', 'WACC −100 bp', -0.01), ('w_m50', '−50 bp', -0.005), ('w_base', 'Base WACC', 0.0), ('w_p50', '+50 bp', 0.005), ('w_p100', '+100 bp', 0.01)],
    'growth_cases': [('g_m100', 'g −100 bp', -0.01), ('g_m50', '−50 bp', -0.005), ('g_base', 'Base growth', 0.0), ('g_p50', '+50 bp', 0.005), ('g_p100', '+100 bp', 0.01)],
    'multiple_cases': [('m_m2', 'Multiple −2.0x', -2.0), ('m_m1', '−1.0x', -1.0), ('m_base', 'Base multiple', 0.0), ('m_p1', '+1.0x', 1.0), ('m_p2', '+2.0x', 2.0)],
}

# the price-per-share formula shared by the two sensitivity pivots: w and g (or the multiple) shift by the case deltas;
# the projection itself does not depend on the discount rate, so the cash flows are read from the fcf pivot
def price_formula(tv_expr):
    w = '(wacc.wacc + wacc_case.delta)'
    return (f'((NPV({w}, fcf.ufcf[period.frame=fcst]) * (1 + {w}) ^ 0.5 + {tv_expr} / (1 + {w}) ^ fcf.n[period=last]) - wacc.net_debt) / wacc.shares')

doc = {
  'model': 'dcf', 'name': 'Helix Software — discounted cash flow (illustrative)', 'units': 'USD millions except per-share',
  'periods': {'start': '2025-01', 'count': 6, 'grain': 'year', 'histUntil': '2025-12-31'},
  'tables': {
    'methods': {'name': 'Terminal value method', 'rows': [{'id': 'perpetuity', 'name': 'Perpetuity growth'}, {'id': 'exit_multiple', 'name': 'Exit multiple'}]},
    **{t: {'name': {'wacc_cases': 'WACC cases', 'growth_cases': 'Terminal growth cases', 'multiple_cases': 'Exit multiple cases'}[t], 'rows': [dict(id=i, name=n, delta=d) for i, n, d in rows]} for t, rows in CASES.items()},
  },
  'pivots': {
    'drivers': {'name': 'Operating drivers', 'lines': [L('revenue_growth', 'Revenue growth', PCT), L('ebitda_margin', 'EBITDA margin', PCT), L('da_pct', 'D&A, % of revenue', PCT), L('capex_pct', 'Capex, % of revenue', PCT), L('nwc_pct', 'Net working capital, % of revenue change', PCT), L('tax_rate', 'Cash tax rate', PCT)],
      'inputs': DRIVERS},
    'wacc': {'name': 'WACC, terminal value and equity bridge', 'dims': {'period': False},
      'lines': [L(i, n, f) for i, n, f, *_ in [(x[0], x[1], x[2] if len(x) > 2 else None) for x in WACC]],
      'values': [dict(at=dict(line=i), value=v) for i, n, f, v in [x for x in WACC if len(x) == 4] if v is not None] + [dict(at=dict(line=k), value=v) for k, v in WACC_VALUES.items()],
      'rules': ['cost_of_equity = risk_free + beta * erp', 'after_tax_cost_of_debt = pre_tax_cost_of_debt * (1 - tax_rate)', 'equity_weight = 1 - debt_weight',
                'wacc = equity_weight * cost_of_equity + debt_weight * after_tax_cost_of_debt']},
    'fcf': {'name': 'Unlevered free cash flow',
      'lines': [L('revenue', 'Revenue'), L('revenue_growth', 'Revenue growth', PCT), L('ebitda', 'EBITDA'), L('ebitda_margin', 'EBITDA margin', PCT), L('da', 'Less: D&A'), L('ebit', 'EBIT'), L('tax', 'Less: cash taxes'), L('nopat', 'NOPAT'),
                L('capex', 'Less: capex'), L('nwc_change', 'Less: increase in net working capital'), L('ufcf', 'Unlevered free cash flow'), L('n', 'Year (from valuation date)'), L('discount_factor', 'Discount factor (mid-year)'), L('pv_ufcf', 'PV of unlevered free cash flow')],
      'inputs': {'revenue': {'fy2025': 520}, 'ebitda': {'fy2025': 140}, 'da': {'fy2025': 18}, 'capex': {'fy2025': 26}, 'nwc_change': {'fy2025': 9}},
      'rules': ['revenue[frame=fcst] = PREV(revenue) * (1 + drivers.revenue_growth)', 'revenue_growth = IFERROR(revenue / PREV(revenue) - 1, BLANK)',
                'ebitda[frame=fcst] = revenue * drivers.ebitda_margin', 'ebitda_margin = ebitda / revenue', 'da[frame=fcst] = revenue * drivers.da_pct',
                'ebit = ebitda - da', 'tax[frame=fcst] = IF(ebit > 0, ebit * drivers.tax_rate, 0)', 'nopat[frame=fcst] = ebit - tax',
                'capex[frame=fcst] = revenue * drivers.capex_pct', 'nwc_change[frame=fcst] = (revenue - PREV(revenue)) * drivers.nwc_pct',
                'ufcf[frame=fcst] = nopat + da - capex - nwc_change', 'n = period.idx',
                'discount_factor[frame=fcst] = 1 / (1 + wacc.wacc) ^ (n - 0.5)', 'pv_ufcf[frame=fcst] = ufcf * discount_factor']},
    'valuation': {'name': 'Valuation by terminal value method', 'dims': {'method': 'methods', 'period': False},
      'lines': [L('sum_pv_ufcf', 'PV of forecast cash flows'), L('terminal_value', 'Terminal value'), L('pv_terminal', 'PV of terminal value'), L('enterprise_value', 'Enterprise value'), L('net_debt', 'Less: net debt'), L('equity_value', 'Equity value'),
                L('per_share', 'Equity value per share ($)'), L('current_price', 'Current share price ($)'), L('premium', 'Implied premium to current', PCT), L('tv_share', 'Terminal value, % of EV', PCT),
                L('implied_multiple', 'Implied exit multiple, EV / EBITDA (x)'), L('implied_growth', 'Implied perpetuity growth', PCT), L('ev_ltm_ebitda', 'Implied EV / LTM EBITDA (x)')],
      'rules': ['sum_pv_ufcf = SUM(fcf.pv_ufcf[period.frame=fcst])',
                'terminal_value[method=perpetuity] = fcf.ufcf[period=last] * (1 + wacc.terminal_growth) / (wacc.wacc - wacc.terminal_growth)',
                'terminal_value[method=exit_multiple] = fcf.ebitda[period=last] * wacc.exit_multiple',
                'pv_terminal = terminal_value / (1 + wacc.wacc) ^ fcf.n[period=last]', 'enterprise_value = sum_pv_ufcf + pv_terminal',
                'net_debt = wacc.net_debt', 'equity_value = enterprise_value - net_debt', 'per_share = equity_value / wacc.shares', 'current_price = wacc.current_price',
                'premium = per_share / current_price - 1', 'tv_share = pv_terminal / enterprise_value',
                'implied_multiple = terminal_value / fcf.ebitda[period=last]',
                'implied_growth = (terminal_value * wacc.wacc - fcf.ufcf[period=last]) / (terminal_value + fcf.ufcf[period=last])',
                'ev_ltm_ebitda = enterprise_value / fcf.ebitda[period=first]']},
    'sensitivity_growth': {'name': 'Price per share: WACC × terminal growth', 'dims': {'wacc_case': 'wacc_cases', 'growth_case': 'growth_cases', 'period': False}, 'lines': [L('per_share', 'Equity value per share ($)')],
      'rules': ['per_share = ' + price_formula('fcf.ufcf[period=last] * (1 + wacc.terminal_growth + growth_case.delta) / ((wacc.wacc + wacc_case.delta) - (wacc.terminal_growth + growth_case.delta))')]},
    'sensitivity_multiple': {'name': 'Price per share: WACC × exit multiple', 'dims': {'wacc_case': 'wacc_cases', 'multiple_case': 'multiple_cases', 'period': False}, 'lines': [L('per_share', 'Equity value per share ($)')],
      'rules': ['per_share = ' + price_formula('fcf.ebitda[period=last] * (wacc.exit_multiple + multiple_case.delta)')]},
  },
  'outputs': [
    {'pivot': 'fcf', 'rows': ['line'], 'cols': ['period'], 'title': 'Unlevered free cash flow', 'decimals': 1},
    {'pivot': 'valuation', 'rows': ['line'], 'cols': ['method'], 'title': 'Valuation', 'decimals': 1},
    {'pivot': 'sensitivity_growth', 'rows': ['wacc_case'], 'cols': ['growth_case'], 'title': 'Price per share: WACC × terminal growth', 'decimals': 1},
    {'pivot': 'sensitivity_multiple', 'rows': ['wacc_case'], 'cols': ['multiple_case'], 'title': 'Price per share: WACC × exit multiple', 'decimals': 1},
  ],
  'dashboards': [{'id': 'overview', 'name': 'Helix Software: DCF valuation', 'theme': 'banking', 'cards': [
    {'kind': 'kpi', 'pivot': 'valuation', 'line': 'enterprise_value', 'cols': [], 'pages': {'method': 'perpetuity'}, 'title': 'EV, perpetuity growth', 'unit': '$M'},
    {'kind': 'kpi', 'pivot': 'valuation', 'line': 'per_share', 'cols': [], 'pages': {'method': 'perpetuity'}, 'title': 'Per share, perpetuity growth', 'unit': '$'},
    {'kind': 'kpi', 'pivot': 'valuation', 'line': 'per_share', 'cols': [], 'pages': {'method': 'exit_multiple'}, 'title': 'Per share, exit multiple', 'unit': '$'},
    {'kind': 'kpi', 'pivot': 'valuation', 'line': 'premium', 'cols': [], 'pages': {'method': 'perpetuity'}, 'title': 'Premium to current price'},
    {'kind': 'table', 'pivot': 'valuation', 'rows': ['line'], 'cols': ['method'], 'title': 'Valuation summary: perpetuity growth vs exit multiple', 'w': 6},
    {'kind': 'table', 'pivot': 'wacc', 'rows': ['line'], 'editable': True, 'title': 'WACC build-up, terminal value and equity bridge (edit any input)', 'w': 6},
    {'kind': 'table', 'pivot': 'drivers', 'rows': ['line'], 'cols': ['period'], 'periods': FCST, 'editable': True, 'title': 'Operating drivers by year (edit any cell)'},
    {'kind': 'table', 'pivot': 'fcf', 'rows': ['line'], 'cols': ['period'], 'title': 'Unlevered free cash flow and present value (FY2025 actual, FY2026 to FY2030 projected)'},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'fcf', 'rows': ['line'], 'cols': ['period'], 'lines': ['revenue', 'ebitda', 'ufcf'], 'title': 'Revenue, EBITDA and unlevered free cash flow', 'w': 6},
    {'kind': 'chart', 'type': 'line', 'pivot': 'fcf', 'rows': ['line'], 'cols': ['period'], 'lines': ['revenue_growth', 'ebitda_margin'], 'periods': FCST, 'title': 'Growth and margin', 'w': 6},
    {'kind': 'table', 'pivot': 'sensitivity_growth', 'rows': ['wacc_case'], 'cols': ['growth_case'], 'title': 'Price per share ($): WACC × terminal growth', 'w': 6},
    {'kind': 'table', 'pivot': 'sensitivity_multiple', 'rows': ['wacc_case'], 'cols': ['multiple_case'], 'title': 'Price per share ($): WACC × exit multiple', 'w': 6},
    {'kind': 'chart', 'type': 'stackedBar', 'pivot': 'valuation', 'rows': ['line'], 'cols': ['method'], 'lines': ['sum_pv_ufcf', 'pv_terminal'], 'title': 'Enterprise value: forecast cash flows and terminal value', 'w': 6},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'sensitivity_growth', 'rows': ['growth_case'], 'cols': ['wacc_case'], 'title': 'Price per share across WACC and terminal growth', 'w': 6},
  ]}],
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dcf.json')
with open(out, 'w') as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out))
