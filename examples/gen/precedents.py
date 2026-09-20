#!/usr/bin/env python3
"""Generates examples/precedents.json: a precedent transactions analysis for a software target, laid out the
way a banker's page is: the selected transactions with their terms and multiples, summary statistics over the
set and over subsets (strategic vs sponsor, recent), and the implied valuation of the subject at each statistic,
with an editable subject block. Companies and deals are fictional; figures are illustrative.

Run: python3 examples/gen/precedents.py
"""
import json, os

# acquirer, target, announced (YYYY-MM), type, consideration, EV ($M), target LTM revenue, target LTM EBITDA, 1-day premium, 30-day VWAP premium
DEALS = [
    ('Vantage Systems', 'Meridian Health IT', '2022-05', 'strategic', 'cash', 4200, 460, 110, 0.38, 0.44),
    ('Crestline Partners', 'Arbor Analytics', '2022-09', 'sponsor', 'cash', 1650, 190, 44, 0.27, 0.33),
    ('Northgate Software', 'Lumen Payroll', '2023-02', 'strategic', 'cash and stock', 3100, 355, 92, 0.31, 0.36),
    ('Halcyon Capital', 'Keystone Compliance', '2023-06', 'sponsor', 'cash', 2400, 300, 66, 0.32, 0.39),
    ('Orbital Group', 'Vega Logistics Cloud', '2023-10', 'strategic', 'stock', 5600, 640, 150, 0.45, 0.52),
    ('Pike Holdings', 'Rho Field Service', '2024-03', 'strategic', 'cash', 5100, 610, 158, 0.41, 0.47),
    ('Sable Equity', 'Tau Property Software', '2024-07', 'sponsor', 'cash', 1900, 205, 49, 0.28, 0.31),
    ('Summit Technologies', 'Nimbus Clinical', '2024-11', 'strategic', 'cash', 6900, 720, 195, 0.36, 0.42),
    ('Kappa Industries', 'Nu Manufacturing Suite', '2025-02', 'strategic', 'cash and stock', 7800, 880, 246, 0.36, 0.40),
    ('Iota Partners', 'Mu Insurance Platform', '2025-06', 'sponsor', 'cash', 3300, 410, 98, 0.30, 0.35),
    ('Beacon Software', 'Juniper Legal Tech', '2025-11', 'strategic', 'cash', 2950, 310, 84, 0.34, 0.38),
    ('Atlas Global', 'Copper Energy Software', '2026-04', 'strategic', 'cash', 4750, 505, 141, 0.39, 0.46),
]
MON = {'01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'}

def L(id, name, fmt=None):
    d = {'id': id, 'name': name}
    if fmt: d['format'] = fmt
    return d
PCT = 'percent'

deals = []
for i, (acq, tgt, ym, typ, cons, ev, rev, ebitda, p1, p30) in enumerate(DEALS, 1):
    y, m = ym.split('-')
    # the member name is the target, so chart axes stay short; the acquirer and the terms travel in a text measure shown as an extra column
    deals.append(dict(id=f'd{i:02d}', name=tgt, acquirer=acq, target=tgt, announced=f'{ym}-15', year=int(y), type=typ, consideration=cons,
                      ev=ev, target_revenue=rev, target_ebitda=ebitda, premium_1d=p1, premium_30d=p30, terms=f'{acq} · {typ} · {cons.replace(" and ", " & ")} · {MON[m]} {y[2:]}'))

STATS = [('low', 'Low'), ('mean', 'Mean'), ('median', 'Median'), ('high', 'High'), ('median_strategic', 'Median: strategic'), ('median_sponsor', 'Median: sponsor'), ('median_recent', 'Median: 2025 onward')]
MULT = ['ev_revenue', 'ev_ebitda', 'premium_1d', 'premium_30d']

doc = {
  'model': 'precedents', 'name': 'Helix Software — precedent transactions (illustrative)', 'units': 'USD millions except per-share',
  'tables': {
    'deals': {'name': 'Selected transactions', 'fields': {'name': 'text', 'acquirer': 'text', 'target': 'text', 'announced': 'date', 'year': 'number', 'type': 'text', 'consideration': 'text', 'ev': 'number', 'target_revenue': 'number', 'target_ebitda': 'number', 'premium_1d': 'number', 'premium_30d': 'number', 'terms': 'text'}, 'rows': deals},
    'stats': {'name': 'Statistics', 'rows': [dict(id=i, name=n) for i, n in STATS]},
  },
  'pivots': {
    'subject': {'name': 'Helix Software (subject)', 'dims': {'period': False},
      'lines': [L('revenue', 'LTM revenue'), L('ebitda', 'LTM EBITDA'), L('net_debt', 'Net debt'), L('shares', 'Diluted shares (M)'), L('price', 'Current share price ($)')],
      'values': [dict(at=dict(line=l), value=v) for l, v in (('revenue', 520), ('ebitda', 140), ('net_debt', 200), ('shares', 60), ('price', 58.0))]},
    'multiples': {'name': 'Transaction multiples', 'dims': {'deal': 'deals'}, 'measures': ['value', {'id': 'terms', 'type': 'text', 'name': 'Terms'}],
      'lines': [L('ev', 'Enterprise value'), L('revenue', 'Target LTM revenue'), L('ebitda', 'Target LTM EBITDA'), L('ebitda_margin', 'EBITDA margin', PCT), L('ev_revenue', 'EV / Revenue (x)'), L('ev_ebitda', 'EV / EBITDA (x)'), L('premium_1d', 'Premium, 1 day', PCT), L('premium_30d', 'Premium, 30-day VWAP', PCT)],
      'values': [dict(at=dict(deal=d['id'], line='ev'), measure='terms', value=d['terms']) for d in deals],
      'rules': ['ev = deal.ev', 'revenue = deal.target_revenue', 'ebitda = deal.target_ebitda', 'ebitda_margin = ebitda / revenue', 'ev_revenue = ev / revenue', 'ev_ebitda = ev / ebitda', 'premium_1d = deal.premium_1d', 'premium_30d = deal.premium_30d']},
    'summary': {'name': 'Summary statistics', 'lineTable': 'multiples_lines', 'dims': {'stat': 'stats'},   # named apart from the `stats` member table
      'rules': ['value[stat=low] = MIN(multiples.value)', 'value[stat=mean] = AVG(multiples.value)', 'value[stat=median] = MEDIAN(multiples.value)', 'value[stat=high] = MAX(multiples.value)',
                'value[stat=median_strategic] = MEDIAN(multiples.value[deal.type=strategic])', 'value[stat=median_sponsor] = MEDIAN(multiples.value[deal.type=sponsor])', 'value[stat=median_recent] = MEDIAN(multiples.value[deal.year >= 2025])']},
    'implied': {'name': 'Implied valuation of Helix', 'dims': {'stat': 'stats'},
      'lines': [L('ev_from_revenue', 'Implied EV at EV / Revenue'), L('ev_from_ebitda', 'Implied EV at EV / EBITDA'), L('equity_from_revenue', 'Implied equity value at EV / Revenue'), L('equity_from_ebitda', 'Implied equity value at EV / EBITDA'),
                L('price_from_revenue', 'Implied price at EV / Revenue ($)'), L('price_from_ebitda', 'Implied price at EV / EBITDA ($)'), L('price_from_premium', 'Implied price at 1-day premium ($)'), L('price_from_premium_30d', 'Implied price at 30-day premium ($)'),
                L('current_price', 'Current price ($)'), L('premium_from_revenue', 'Implied premium: EV / Revenue', PCT), L('premium_from_ebitda', 'Implied premium: EV / EBITDA', PCT)],
      'rules': ['ev_from_revenue = summary.value[line=ev_revenue] * subject.revenue', 'ev_from_ebitda = summary.value[line=ev_ebitda] * subject.ebitda',
                'equity_from_revenue = ev_from_revenue - subject.net_debt', 'equity_from_ebitda = ev_from_ebitda - subject.net_debt',
                'price_from_revenue = equity_from_revenue / subject.shares', 'price_from_ebitda = equity_from_ebitda / subject.shares',
                'price_from_premium = subject.price * (1 + summary.value[line=premium_1d])', 'price_from_premium_30d = subject.price * (1 + summary.value[line=premium_30d])',
                'current_price = subject.price', 'premium_from_revenue = price_from_revenue / current_price - 1', 'premium_from_ebitda = price_from_ebitda / current_price - 1']},
  },
  'outputs': [
    {'pivot': 'multiples', 'rows': ['deal'], 'cols': ['line'], 'title': 'Selected precedent transactions', 'decimals': 2},
    {'pivot': 'summary', 'rows': ['line'], 'cols': ['stat'], 'lines': MULT, 'title': 'Summary statistics', 'decimals': 2},
    {'pivot': 'implied', 'rows': ['line'], 'cols': ['stat'], 'title': 'Implied valuation of Helix', 'decimals': 1},
  ],
  'dashboards': [{'id': 'overview', 'name': 'Helix Software: precedent transactions', 'theme': 'banking', 'cards': [
    {'kind': 'kpi', 'pivot': 'summary', 'line': 'ev_ebitda', 'cols': [], 'pages': {'stat': 'median'}, 'title': 'Median EV / EBITDA', 'unit': 'x'},
    {'kind': 'kpi', 'pivot': 'summary', 'line': 'ev_revenue', 'cols': [], 'pages': {'stat': 'median'}, 'title': 'Median EV / Revenue', 'unit': 'x'},
    {'kind': 'kpi', 'pivot': 'summary', 'line': 'premium_1d', 'cols': [], 'pages': {'stat': 'median'}, 'title': 'Median 1-day premium'},
    {'kind': 'kpi', 'pivot': 'implied', 'line': 'price_from_ebitda', 'cols': [], 'pages': {'stat': 'median'}, 'title': 'Implied price at median EV / EBITDA', 'unit': '$'},
    {'kind': 'table', 'pivot': 'multiples', 'rows': ['deal'], 'cols': ['line'], 'extra': [{'measure': 'terms', 'label': 'Acquirer · type · consideration · announced', 'pages': {'line': 'ev'}}], 'title': 'Selected precedent transactions (USD millions; target, then acquirer and terms at right)'},
    {'kind': 'table', 'pivot': 'summary', 'rows': ['line'], 'cols': ['stat'], 'lines': MULT, 'title': 'Summary statistics'},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'multiples', 'rows': ['line'], 'cols': ['deal'], 'lines': ['ev_ebitda'], 'title': 'EV / EBITDA by target', 'w': 6},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'multiples', 'rows': ['line'], 'cols': ['deal'], 'lines': ['premium_1d', 'premium_30d'], 'title': 'Premium paid by target', 'w': 6},
    {'kind': 'table', 'pivot': 'subject', 'rows': ['line'], 'editable': True, 'title': 'Helix Software: subject inputs (edit any cell)', 'w': 4},
    {'kind': 'table', 'pivot': 'implied', 'rows': ['line'], 'cols': ['stat'], 'title': 'Implied valuation of Helix at each statistic', 'w': 8},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'implied', 'rows': ['line'], 'cols': ['stat'], 'lines': ['price_from_revenue', 'price_from_ebitda', 'price_from_premium'], 'filters': {'stat': ['low', 'median', 'mean', 'high']}, 'title': 'Implied price per share by method and statistic ($)', 'w': 12},
  ]}],
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'precedents.json')
with open(out, 'w') as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out))
