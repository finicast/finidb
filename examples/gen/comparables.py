#!/usr/bin/env python3
"""Generates examples/comparables.json: Apple against seven peers, in the layout a banker's comps page uses.

One pivot (company × line) carries the financial inputs (LTM and NTM as separate lines) and the derived
multiples side by side, so a single table shows Revenue LTM | Revenue NTM | … | EV/EBITDA LTM | EV/EBITDA NTM.
Peer statistics and the implied valuation are line × statistic pivots over it. Figures are illustrative.

Run: python3 examples/gen/comparables.py
"""
import json, os

COMPANIES = [
    ('aapl', 'Apple', 'AAPL', 'target', 0), ('msft', 'Microsoft', 'MSFT', 'platform', 1), ('googl', 'Alphabet', 'GOOGL', 'platform', 1), ('amzn', 'Amazon', 'AMZN', 'platform', 1),
    ('meta', 'Meta Platforms', 'META', 'platform', 1), ('nvda', 'NVIDIA', 'NVDA', 'platform', 1), ('dell', 'Dell Technologies', 'DELL', 'hardware', 1), ('hpq', 'HP Inc.', 'HPQ', 'hardware', 1)]
# price, diluted shares (M), cash & investments, total debt (USD M)
MARKET = {'aapl': (331.34, 14590, 62400, 84340), 'msft': (497.75, 7430, 76840, 128810), 'googl': (347.33, 12230, 242470, 120790), 'amzn': (251.19, 10790, 122990, 251640),
          'meta': (682.31, 2520, 90260, 112320), 'nvda': (219.34, 24150, 62470, 38860), 'dell': (543.51, 636, 11570, 31920), 'hpq': (33.82, 914.5, 3700, 10860)}
# LTM: revenue, revenue a year earlier, EBITDA, net income, EPS
LTM = {'aapl': (466820, 401030, 167960, 128930, 8.73), 'msft': (331840, 281940, 194240, 133750, 17.94), 'googl': (445870, 358990, 173160, 244120, 19.92), 'amzn': (775680, 648560, 168910, 135280, 12.43),
       'meta': (228250, 178320, 109650, 68100, 26.16), 'nvda': (302970, 147140, 201270, 192880, 7.91), 'dell': (151200, 95700, 17730, 11380, 17.20), 'hpq': (57420, 52680, 4710, 2550, 2.70)}
# NTM consensus-style: revenue, EBITDA, net income, EPS
NTM = {'aapl': (512000, 186000, 142000, 9.80), 'msft': (386000, 228000, 156000, 21.10), 'googl': (512000, 201000, 262000, 21.60), 'amzn': (905000, 205000, 163000, 15.20),
       'meta': (276000, 134000, 80000, 31.40), 'nvda': (423000, 283000, 266000, 10.95), 'dell': (172000, 20400, 13100, 20.10), 'hpq': (59500, 5000, 2750, 2.95)}

def L(id, name, fmt=None):
    d = {'id': id, 'name': name}
    if fmt: d['format'] = fmt
    return d
PCT = 'percent'

market_values = [{'at': {'company': c, 'line': l}, 'value': v} for c, vals in MARKET.items() for l, v in zip(['price', 'shares', 'cash', 'debt'], vals)]
fin_values = []
for c, (r, rp, e, ni, eps) in LTM.items():
    fin_values += [{'at': {'company': c, 'line': l}, 'value': v} for l, v in zip(['revenue_ltm', 'revenue_prior', 'ebitda_ltm', 'net_income_ltm', 'eps_ltm'], (r, rp, e, ni, eps))]
for c, (r, e, ni, eps) in NTM.items():
    fin_values += [{'at': {'company': c, 'line': l}, 'value': v} for l, v in zip(['revenue_ntm', 'ebitda_ntm', 'net_income_ntm', 'eps_ntm'], (r, e, ni, eps))]

MULTIPLES = ['ev_revenue_ltm', 'ev_revenue_ntm', 'ev_ebitda_ltm', 'ev_ebitda_ntm', 'pe_ltm', 'pe_ntm']
RATIOS = ['rev_growth_ltm', 'rev_growth_ntm', 'ebitda_margin_ltm', 'ebitda_margin_ntm']
PERFORMANCE = ['revenue_ltm', 'revenue_ntm', 'ebitda_ltm', 'ebitda_ntm', 'eps_ltm', 'eps_ntm', 'rev_growth_ltm', 'rev_growth_ntm', 'ebitda_margin_ltm', 'ebitda_margin_ntm']
VALUATION = ['market_cap', 'net_debt', 'ev'] + MULTIPLES

doc = {
  'model': 'comps', 'name': 'Apple — comparable companies (illustrative, Sep 2026)', 'units': 'USD millions except per-share',
  'tables': {
    'companies': {'name': 'Companies', 'fields': {'name': 'text', 'ticker': 'text', 'group': 'text', 'peer': 'number'}, 'rows': [dict(zip(['id', 'name', 'ticker', 'group', 'peer'], r)) for r in COMPANIES]},
    'stats': {'name': 'Statistics', 'rows': [{'id': 'low', 'name': 'Low'}, {'id': 'mean', 'name': 'Mean'}, {'id': 'median', 'name': 'Median'}, {'id': 'high', 'name': 'High'}, {'id': 'median_platform', 'name': 'Median: platforms'}, {'id': 'median_hardware', 'name': 'Median: hardware'}]},
  },
  'pivots': {
    'market_data': {'name': 'Market data', 'dims': {'company': 'companies'},
      'lines': [L('price', 'Share price ($)'), L('shares', 'Diluted shares (M)'), L('cash', 'Cash & investments'), L('debt', 'Total debt')],
      'values': market_values},
    'comps': {'name': 'Comparable companies', 'dims': {'company': 'companies'},
      'lines': [L('market_cap', 'Market cap'), L('net_debt', 'Net debt (cash)'), L('ev', 'Enterprise value'),
                L('revenue_ltm', 'Revenue LTM'), L('revenue_ntm', 'Revenue NTM'), L('revenue_prior', 'Revenue, year before LTM'),
                L('ebitda_ltm', 'EBITDA LTM'), L('ebitda_ntm', 'EBITDA NTM'), L('net_income_ltm', 'Net income LTM'), L('net_income_ntm', 'Net income NTM'), L('eps_ltm', 'EPS LTM ($)'), L('eps_ntm', 'EPS NTM ($)'),
                L('rev_growth_ltm', 'Revenue growth LTM', PCT), L('rev_growth_ntm', 'Revenue growth NTM', PCT), L('ebitda_margin_ltm', 'EBITDA margin LTM', PCT), L('ebitda_margin_ntm', 'EBITDA margin NTM', PCT),
                L('ev_revenue_ltm', 'EV / Revenue LTM (x)'), L('ev_revenue_ntm', 'EV / Revenue NTM (x)'), L('ev_ebitda_ltm', 'EV / EBITDA LTM (x)'), L('ev_ebitda_ntm', 'EV / EBITDA NTM (x)'), L('pe_ltm', 'P / E LTM (x)'), L('pe_ntm', 'P / E NTM (x)')],
      'values': fin_values,
      'rules': ['market_cap = market_data.price * market_data.shares', 'net_debt = market_data.debt - market_data.cash', 'ev = market_cap + net_debt',
                'rev_growth_ltm = revenue_ltm / revenue_prior - 1', 'rev_growth_ntm = revenue_ntm / revenue_ltm - 1',
                'ebitda_margin_ltm = ebitda_ltm / revenue_ltm', 'ebitda_margin_ntm = ebitda_ntm / revenue_ntm',
                'ev_revenue_ltm = ev / revenue_ltm', 'ev_revenue_ntm = ev / revenue_ntm', 'ev_ebitda_ltm = ev / ebitda_ltm', 'ev_ebitda_ntm = ev / ebitda_ntm',
                'pe_ltm = market_data.price / eps_ltm', 'pe_ntm = market_data.price / eps_ntm']},
    'peer_stats': {'name': 'Peer statistics', 'lineTable': 'comps_lines', 'dims': {'stat': 'stats'},
      'rules': ['value[stat=low] = MIN(comps.value[company.peer=1])', 'value[stat=mean] = AVG(comps.value[company.peer=1])', 'value[stat=median] = MEDIAN(comps.value[company.peer=1])', 'value[stat=high] = MAX(comps.value[company.peer=1])',
                'value[stat=median_platform] = MEDIAN(comps.value[company.group=platform])', 'value[stat=median_hardware] = MEDIAN(comps.value[company.group=hardware])']},
    'implied': {'name': 'Implied Apple valuation', 'dims': {'stat': 'stats'},
      'lines': [L('price_ev_revenue_ltm', 'Price at peer EV / Revenue LTM ($)'), L('price_ev_revenue_ntm', 'Price at peer EV / Revenue NTM ($)'), L('price_ev_ebitda_ltm', 'Price at peer EV / EBITDA LTM ($)'), L('price_ev_ebitda_ntm', 'Price at peer EV / EBITDA NTM ($)'), L('price_pe_ltm', 'Price at peer P / E LTM ($)'), L('price_pe_ntm', 'Price at peer P / E NTM ($)'),
                L('current_price', 'Current Apple price ($)'),
                L('upside_ev_revenue_ltm', 'vs current: EV / Revenue LTM', PCT), L('upside_ev_revenue_ntm', 'vs current: EV / Revenue NTM', PCT), L('upside_ev_ebitda_ltm', 'vs current: EV / EBITDA LTM', PCT), L('upside_ev_ebitda_ntm', 'vs current: EV / EBITDA NTM', PCT), L('upside_pe_ltm', 'vs current: P / E LTM', PCT), L('upside_pe_ntm', 'vs current: P / E NTM', PCT)],
      'rules': [f'price_ev_revenue_{b} = (peer_stats.value[line=ev_revenue_{b}] * comps.revenue_{b}[company=aapl] - comps.net_debt[company=aapl]) / market_data.shares[company=aapl]' for b in ('ltm', 'ntm')] +
               [f'price_ev_ebitda_{b} = (peer_stats.value[line=ev_ebitda_{b}] * comps.ebitda_{b}[company=aapl] - comps.net_debt[company=aapl]) / market_data.shares[company=aapl]' for b in ('ltm', 'ntm')] +
               [f'price_pe_{b} = peer_stats.value[line=pe_{b}] * comps.eps_{b}[company=aapl]' for b in ('ltm', 'ntm')] +
               ['current_price = market_data.price[company=aapl]'] +
               [f'upside_{m}_{b} = price_{m}_{b} / current_price - 1' for m in ('ev_revenue', 'ev_ebitda', 'pe') for b in ('ltm', 'ntm')]},
  },
  'outputs': [
    {'pivot': 'comps', 'rows': ['company'], 'cols': ['line'], 'lines': PERFORMANCE, 'title': 'Financial performance', 'decimals': 2},
    {'pivot': 'comps', 'rows': ['company'], 'cols': ['line'], 'lines': VALUATION, 'title': 'Valuation and multiples', 'decimals': 2},
    {'pivot': 'peer_stats', 'rows': ['line'], 'cols': ['stat'], 'lines': MULTIPLES + RATIOS, 'title': 'Peer statistics', 'decimals': 2},
    {'pivot': 'implied', 'rows': ['line'], 'cols': ['stat'], 'title': 'Implied Apple valuation', 'decimals': 1},
  ],
  'dashboards': [{'id': 'overview', 'name': 'Apple comps', 'cards': [
    {'kind': 'table', 'pivot': 'market_data', 'rows': ['company'], 'cols': ['line'], 'editable': True, 'title': 'Market data (edit any cell)'},
    {'kind': 'table', 'pivot': 'comps', 'rows': ['company'], 'cols': ['line'], 'lines': PERFORMANCE, 'editable': True, 'title': 'Financial performance, LTM and NTM (edit any input)'},
    {'kind': 'table', 'pivot': 'comps', 'rows': ['company'], 'cols': ['line'], 'lines': VALUATION, 'title': 'Valuation and trading multiples, LTM and NTM'},
    {'kind': 'table', 'pivot': 'peer_stats', 'rows': ['line'], 'cols': ['stat'], 'lines': MULTIPLES + RATIOS, 'title': 'Peer statistics (Apple excluded)'},
    {'kind': 'table', 'pivot': 'implied', 'rows': ['line'], 'cols': ['stat'], 'title': 'Implied Apple valuation'},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'comps', 'rows': ['line'], 'cols': ['company'], 'lines': ['ev_ebitda_ltm', 'ev_ebitda_ntm'], 'title': 'EV / EBITDA by company, LTM vs NTM', 'w': 6},
    {'kind': 'chart', 'type': 'bar', 'pivot': 'comps', 'rows': ['line'], 'cols': ['company'], 'lines': ['rev_growth_ltm', 'rev_growth_ntm'], 'title': 'Revenue growth by company, LTM vs NTM', 'w': 6},
  ]}],
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'comparables.json')
with open(out, 'w') as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out))
