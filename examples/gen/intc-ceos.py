"""Intel share price under five CEOs: a stock chart annotated with each appointment, a tenure scorecard, and
the daily closes behind every month. Prices come from Financial Modeling Prep at generation time and are frozen
in the document with an as-of date. Run: FMP_API_KEY=… python3 intc-ceos.py (or the key is read from ../../../.env)."""
import json, os, sys, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
def key():
    k = os.environ.get('FMP_API_KEY')
    if k: return k
    env = os.path.join(HERE, '..', '..', '..', '.env')
    for line in open(env):
        if line.startswith('FMP_API_KEY='): return line.split('=', 1)[1].strip().strip('"')
    sys.exit('FMP_API_KEY not found')

START, END = '2013-01-01', dt.date.today().isoformat()
url = f'https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=INTC&from={START}&to={END}&apikey={key()}'
days = json.load(urllib.request.urlopen(url))
days = sorted(days, key=lambda r: r['date'])
asof = days[-1]['date']
MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
def pid(d): y, m = int(d[:4]), int(d[5:7]); return f'{MON[m - 1]}{str(y)[2:]}'
first = dt.date(2013, 1, 1); last = dt.date.fromisoformat(asof)
count = (last.year - first.year) * 12 + (last.month - first.month) + 1
last_pid = pid(asof)

# month_end marks the last trading day of each month, so the month-end close is a SUMIFS (exports to Excel), not a LAST
prices = [{'id': r['date'], 'date': r['date'], 'close': round(float(r['price']), 2), 'volume': int(r.get('volume') or 0), 'month_end': 1 if i + 1 == len(days) or days[i + 1]['date'][:7] != r['date'][:7] else 0} for i, r in enumerate(days)]

# Intel's chief executives since 2013 (appointment month as the period id; the current CEO runs to the last month)
CEOS = [
  {'id': 'krzanich', 'name': 'Brian Krzanich', 'role': 'CEO', 'start': 'may13', 'end': 'jun18', 'note': 'Promoted from COO; resigned June 2018.'},
  {'id': 'swan_interim', 'name': 'Bob Swan (interim)', 'role': 'Interim CEO', 'start': 'jun18', 'end': 'jan19', 'note': 'CFO named interim CEO.'},
  {'id': 'swan', 'name': 'Bob Swan', 'role': 'CEO', 'start': 'jan19', 'end': 'feb21', 'note': 'Made permanent January 2019.'},
  {'id': 'gelsinger', 'name': 'Pat Gelsinger', 'role': 'CEO', 'start': 'feb21', 'end': 'dec24', 'note': 'Returned from VMware; IDM 2.0 strategy; retired December 2024.'},
  {'id': 'interim_2024', 'name': 'Zinsner and Holthaus (interim)', 'role': 'Interim co-CEOs', 'start': 'dec24', 'end': 'mar25', 'note': 'CFO and products chief as interim co-CEOs.'},
  {'id': 'tan', 'name': 'Lip-Bu Tan', 'role': 'CEO', 'start': 'mar25', 'end': last_pid, 'note': f'Appointed March 2025; tenure measured to {asof}.'},
]
lines_stock = [
  {'id': 'close', 'name': 'Month-end close ($)'}, {'id': 'high', 'name': 'Monthly high ($)'}, {'id': 'low', 'name': 'Monthly low ($)'},
  {'id': 'avg', 'name': 'Monthly average ($)'}, {'id': 'return_mom', 'name': 'Return, month over month', 'format': 'percent'},
  {'id': 'return_ytd', 'name': 'Return since January 2013', 'format': 'percent'},
]
# the marks come from the ceos table itself: one event line per permanent CEO, one shaded span per interim period
annotations = [
  {'table': 'ceos', 'where': {'role': 'CEO'}, 'at': 'start', 'label': 'name', 'color': 'accent'},
  {'table': 'ceos', 'where': {'role': ['Interim CEO', 'Interim co-CEOs']}, 'from': 'start', 'to': 'end', 'label': 'role'},
]

doc = {
  'model': 'intc_ceos', 'name': f'Intel under five CEOs: the share price since 2013 (prices as of {asof})',
  'units': 'USD per share',
  'periods': {'start': '2013-01', 'count': count, 'grain': 'month', 'histUntil': asof},
  'tables': {
    'prices': {'name': 'Daily closes', 'fields': {'date': 'date', 'close': 'number', 'volume': 'number', 'month_end': 'number', 'period': 'ref:periods*'}, 'rows': prices, 'rules': 'period = PERIOD(date, periods)'},
    'ceos': {'name': 'Chief executives', 'fields': {'name': 'text', 'role': 'text', 'start': 'ref:periods', 'end': 'ref:periods', 'note': 'text'}, 'rows': CEOS},
  },
  'pivots': {
    'stock': {'name': 'INTC by month', 'lines': lines_stock, 'rules': [
      'close = SUM(prices.close[period=@period, month_end=1])', 'high = MAX(prices.close[period=@period])', 'low = MIN(prices.close[period=@period])', 'avg = AVG(prices.close[period=@period])',
      'return_mom = IFERROR(close / PREV(close) - 1, BLANK)', 'return_ytd = close / close[period=first] - 1']},
    'tenure': {'name': 'Tenure scorecard', 'dims': {'ceo': 'ceos', 'period': False}, 'lines': [
      {'id': 'start_price', 'name': 'Close, month of appointment ($)'}, {'id': 'end_price', 'name': 'Close, end of tenure ($)'}, {'id': 'months', 'name': 'Months in the role'},
      {'id': 'total_return', 'name': 'Total return', 'format': 'percent'}, {'id': 'annualized', 'name': 'Annualised return', 'format': 'percent'}],
      'rules': ['start_price = stock.close[period=@ceo.start]', 'end_price = stock.close[period=@ceo.end]', 'months = ceo.end.idx - ceo.start.idx',
                'total_return = end_price / start_price - 1', 'annualized = IFERROR((end_price / start_price) ^ (12 / months) - 1, BLANK)']},
  },
  'outputs': [{'pivot': 'tenure', 'rows': ['ceo'], 'cols': ['line'], 'title': 'Tenure scorecard'}, {'pivot': 'stock', 'rows': ['line'], 'cols': ['period'], 'lines': ['close', 'return_mom'], 'title': 'INTC by month'}],
  'dashboards': [
    {'id': 'overview', 'name': 'Intel under five CEOs', 'theme': 'research', 'cards': [
      {'kind': 'text', 'w': 12, 'h': 2, 'text': f'Intel\'s share price by month since 2013, with every chief executive appointment marked. **Click any month** on the chart for the daily closes behind it. The scorecard measures each tenure from the appointment month to the month the successor took over (the current CEO to {asof}). Prices from Financial Modeling Prep as of {asof}; this is a market chart, not a verdict on the people.'},
      {'kind': 'kpi', 'pivot': 'stock', 'line': 'close', 'title': 'INTC, latest month-end close', 'unit': '$', 'w': 3},
      {'kind': 'kpi', 'pivot': 'stock', 'line': 'return_ytd', 'title': 'Return since January 2013', 'w': 3},
      {'kind': 'kpi', 'pivot': 'tenure', 'line': 'total_return', 'cols': ['ceo'], 'filters': {'ceo': ['gelsinger', 'tan']}, 'title': 'Return under Lip-Bu Tan (vs Gelsinger)', 'w': 3},
      {'kind': 'kpi', 'pivot': 'tenure', 'line': 'annualized', 'cols': ['ceo'], 'filters': {'ceo': ['gelsinger', 'tan']}, 'title': 'Annualised, Lip-Bu Tan (vs Gelsinger)', 'w': 3},
      {'kind': 'chart', 'type': 'line', 'pivot': 'stock', 'rows': ['line'], 'cols': ['period'], 'lines': ['close'], 'title': 'INTC month-end close, with each CEO appointment', 'unit': '$', 'w': 12, 'h': 7,
       'annotations': annotations, 'drill': {'dashboard': 'daily', 'params': {'month': '$col'}}},
      {'kind': 'table', 'pivot': 'tenure', 'rows': ['ceo'], 'cols': ['line'], 'title': 'Tenure scorecard: price at appointment, at handover, and the return in between', 'w': 12},
      {'kind': 'text', 'title': 'Notes on the current tenure', 'w': 12, 'h': 2, 'text': '**{{ceos.name[id=tan]}}** — {{ceos.note[id=tan]}} Appointed {{ceos.start[id=tan]}}; {{tenure.months[ceo=tan]}} months in the role, total return {{tenure.total_return[ceo=tan]|percent}}. The previous permanent CEO, **{{ceos.name[id=gelsinger]}}**: {{ceos.note[id=gelsinger]}}'},
      {'kind': 'chart', 'type': 'bar', 'pivot': 'tenure', 'rows': ['ceo'], 'cols': ['line'], 'lines': ['annualized'], 'title': 'Annualised return by tenure', 'w': 6},
      {'kind': 'chart', 'type': 'bar', 'pivot': 'stock', 'rows': ['line'], 'cols': ['period'], 'lines': ['return_mom'], 'title': 'Monthly returns', 'w': 6},
    ]},
    {'id': 'daily', 'name': 'Daily closes', 'theme': 'research', 'params': [{'id': 'month', 'label': 'Month'}], 'cards': [
      {'kind': 'links'},
      {'kind': 'text', 'w': 12, 'h': 1, 'text': 'Daily closes for **$month**: month-end close {{stock.close[period=$month]}}, high {{stock.high[period=$month]}}, low {{stock.low[period=$month]}}. Sort, filter and search; the view is a link.'},
      {'kind': 'data', 'table': 'prices', 'fields': ['date', 'close', 'volume', 'period'], 'where': {'period': '$month'}, 'sort': '-date', 'limit': 100, 'title': 'INTC daily closes', 'h': 10},
    ]},
  ],
}
out = os.path.join(HERE, '..', 'intc-ceos.json')
with open(out, 'w') as fh: json.dump(doc, fh, indent=1, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out), f'{os.path.getsize(out) / 1024:.0f} KB; {len(prices)} daily closes {prices[0]["date"]}..{asof}; {count} months; last month {last_pid}')
