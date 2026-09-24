"""A small investment team's blotter: every trade and every watchlist note is entered by a named person, and the
engine records who entered it and who changed it last. Those columns are ordinary fields, so the desk can chart
contributions per person per month and see whose notes are going stale. Run: python3 trade-desk.py"""
import json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
random.seed(4)

MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
YEAR = 2026
MONTHS = [f'{MON[m]}{str(YEAR)[2:]}' for m in range(9)]          # Jan..Sep 2026

PEOPLE = [
    ('maya', 'Maya Okonkwo', 'Portfolio manager'),
    ('tomas', 'Tomas Lindqvist', 'Analyst, technology'),
    ('priya', 'Priya Raman', 'Analyst, health care'),
    ('dan', 'Dan Whitfield', 'Risk'),
]
TICKERS = [
    ('nvda', 'NVIDIA', 'Semiconductors', 178.2, 'tomas'),
    ('msft', 'Microsoft', 'Software', 512.4, 'tomas'),
    ('lly', 'Eli Lilly', 'Pharmaceuticals', 902.5, 'priya'),
    ('unh', 'UnitedHealth', 'Managed care', 336.1, 'priya'),
    ('asml', 'ASML', 'Semiconductor equipment', 1043.0, 'tomas'),
    ('isrg', 'Intuitive Surgical', 'Medical devices', 566.8, 'priya'),
    ('avgo', 'Broadcom', 'Semiconductors', 361.9, 'tomas'),
    ('vrtx', 'Vertex Pharmaceuticals', 'Biotechnology', 452.3, 'priya'),
]
# the blotter: (id, date, ticker, side, quantity, price, entered_by)
TRADES = []
plan = [
    ('2026-01-14', 'nvda', 'buy', 1200, 141.30, 'maya'), ('2026-01-14', 'msft', 'buy', 400, 471.20, 'maya'),
    ('2026-01-28', 'lly', 'buy', 150, 812.40, 'priya'), ('2026-02-09', 'asml', 'buy', 120, 903.10, 'tomas'),
    ('2026-02-20', 'nvda', 'buy', 600, 152.80, 'tomas'), ('2026-03-03', 'unh', 'buy', 500, 291.60, 'priya'),
    ('2026-03-17', 'msft', 'sell', 150, 498.00, 'maya'), ('2026-04-02', 'isrg', 'buy', 180, 521.40, 'priya'),
    ('2026-04-21', 'avgo', 'buy', 700, 318.70, 'tomas'), ('2026-05-06', 'nvda', 'sell', 400, 168.90, 'maya'),
    ('2026-05-19', 'vrtx', 'buy', 220, 421.80, 'priya'), ('2026-06-08', 'asml', 'buy', 60, 975.30, 'tomas'),
    ('2026-06-25', 'unh', 'sell', 200, 312.40, 'priya'), ('2026-07-07', 'avgo', 'buy', 300, 334.10, 'tomas'),
    ('2026-07-23', 'msft', 'buy', 250, 489.60, 'maya'), ('2026-08-11', 'lly', 'buy', 80, 866.20, 'priya'),
    ('2026-08-27', 'isrg', 'sell', 60, 548.90, 'priya'), ('2026-09-03', 'nvda', 'buy', 500, 171.40, 'tomas'),
    ('2026-09-15', 'vrtx', 'buy', 100, 438.50, 'priya'), ('2026-09-22', 'avgo', 'sell', 250, 357.20, 'maya'),
]
for i, (d, tk, side, qty, px, who) in enumerate(plan, 1):
    TRADES.append(dict(id=f't{i:03d}', date=d, ticker=tk, side=side, quantity=qty, price=px, entered_by=who,
                       note={'buy': 'Adding on the thesis', 'sell': 'Trimming into strength'}[side]))

WATCH = [
    ('nvda', 'owned', 'tomas', 'Data-centre demand still ahead of supply; watching gross margin on the next print.'),
    ('msft', 'owned', 'maya', 'Cloud growth steady; the capex line is the thing to watch.'),
    ('lly', 'owned', 'priya', 'Incretin franchise compounding; supply constraints easing.'),
    ('unh', 'owned', 'priya', 'Trimmed on the cost ratio; keeping a half position while utilisation normalises.'),
    ('asml', 'owned', 'tomas', 'Order book covers two years; export rules are the risk.'),
    ('isrg', 'owned', 'priya', 'Procedure growth intact, install base compounding.'),
    ('avgo', 'owned', 'tomas', 'Custom silicon share gains; software mix lifts margin.'),
    ('vrtx', 'researching', 'priya', 'Pain programme read-out due; sizing a starter position.'),
]
for tk, st, who, note in [('crwd', 'researching', 'tomas', 'Platform consolidation story; waiting on net retention.'),
                          ('now', 'idea', 'maya', 'Worth a look after the guide-down.'),
                          ('regn', 'passed', 'priya', 'Passed: pipeline concentration too high for the sleeve.')]:
    WATCH.append((tk, st, who, note))
EXTRA = {'crwd': ('CrowdStrike', 'Security software', 402.6), 'now': ('ServiceNow', 'Software', 812.0), 'regn': ('Regeneron', 'Biotechnology', 611.4)}

tickers = [dict(id=i, name=n, sector=s, last=p, covered_by=c) for i, n, s, p, c in TICKERS]
tickers += [dict(id=i, name=n, sector=s, last=p, covered_by='priya' if i == 'regn' else 'tomas' if i == 'crwd' else 'maya') for i, (n, s, p) in EXTRA.items()]

doc = {
  'model': 'desk', 'name': 'Trade desk: a team blotter with who entered what',
  'units': 'US dollars',
  'periods': {'start': f'{YEAR}-01', 'count': 9, 'grain': 'month'},
  'tables': {
    'people': {'name': 'People', 'fields': {'role': 'text'},
               'rows': [dict(id=i, name=n, role=r) for i, n, r in PEOPLE]},
    'tickers': {'name': 'Tickers', 'fields': {'sector': 'text', 'last': 'number', 'covered_by': 'ref:people'}, 'rows': tickers},
    'sides': {'name': 'Side', 'rows': [{'id': 'buy', 'name': 'Buy'}, {'id': 'sell', 'name': 'Sell'}]},
    'statuses': {'name': 'Research status', 'rows': [{'id': 'idea', 'name': 'Idea'}, {'id': 'researching', 'name': 'Researching'},
                                                     {'id': 'owned', 'name': 'Owned'}, {'id': 'exited', 'name': 'Exited'}, {'id': 'passed', 'name': 'Passed'}]},
    # the blotter and the notes are tracked: the engine fills added_by, added_at, changed_by and changed_at
    'trades': {'name': 'Trade blotter', 'track': True,
               'fields': {'date': 'date', 'ticker': 'ref:tickers', 'side': 'ref:sides', 'quantity': 'number', 'price': 'number',
                          'entered_by': 'ref:people', 'note': 'text',
                          'value': 'number*', 'signed_shares': 'number*', 'period': 'ref:periods*', 'entered_period': 'ref:periods*'},
               'rows': TRADES,
               'rules': ['value = quantity * price',
                         'signed_shares = quantity * IF(side = "sell", -1, 1)',
                         'period = PERIOD(date, periods)',
                         'entered_period = PERIOD(added_at, periods)']},
    'watchlist': {'name': 'Watchlist and notes', 'track': True,
                  'fields': {'ticker': 'ref:tickers', 'status': 'ref:statuses', 'owner': 'ref:people', 'note': 'text',
                             'noted_period': 'ref:periods*', 'one': 'number*'},
                  'rows': [dict(id=f'w{i:02d}', ticker=tk, status=st, owner=who, note=note) for i, (tk, st, who, note) in enumerate(WATCH, 1)],
                  'rules': ['noted_period = PERIOD(changed_at, periods)', 'one = 1']},
  },
  'pivots': {
    'position': {
      'name': 'Positions', 'dims': {'ticker': 'tickers', 'period': False},
      'lines': [{'id': 'shares', 'name': 'Shares held'}, {'id': 'cost', 'name': 'Cost', 'format': 'currency'},
                {'id': 'last', 'name': 'Last price', 'format': 'currency'}, {'id': 'market_value', 'name': 'Market value', 'format': 'currency'},
                {'id': 'unrealised', 'name': 'Unrealised gain', 'format': 'currency'}, {'id': 'weight', 'name': 'Weight', 'format': 'percent'}],
      'rules': ['shares = SUM(trades.signed_shares[ticker=@ticker])',
                'cost = SUM(trades.value[ticker=@ticker, side=buy]) - SUM(trades.value[ticker=@ticker, side=sell])',
                'last = SUM(tickers.last[id=@ticker])',
                'market_value = shares * last',
                'unrealised = market_value - cost',
                'weight = market_value / fund.market_value'],
    },
    'fund': {
      'name': 'The book', 'dims': {'period': False},
      'lines': [{'id': 'market_value', 'name': 'Market value', 'format': 'currency'}, {'id': 'cost', 'name': 'Cost', 'format': 'currency'},
                {'id': 'unrealised', 'name': 'Unrealised gain', 'format': 'currency'}, {'id': 'names', 'name': 'Names held'}],
      'rules': ['market_value = SUM(position.market_value)', 'cost = SUM(position.cost)',
                'unrealised = market_value - cost', 'names = COUNT(watchlist.one[status=owned])'],
    },
    'contributions': {
      'name': 'Who entered what', 'dims': {'person': 'people', 'period': 'periods'},
      'lines': [{'id': 'trades_entered', 'name': 'Trades entered'}, {'id': 'traded_value', 'name': 'Value entered', 'format': 'currency'},
                {'id': 'notes_touched', 'name': 'Watchlist notes they keep'}],
      'rules': ['trades_entered = COUNT(trades.value[added_by=@person, period=@period])',
                'traded_value = SUM(trades.value[added_by=@person, period=@period])',
                'notes_touched = COUNT(watchlist.one[changed_by=@person])'],
    },
    'coverage': {
      'name': 'By analyst', 'dims': {'person': 'people', 'period': False},
      'lines': [{'id': 'names_covered', 'name': 'Names covered'}, {'id': 'positions', 'name': 'Positions held'},
                {'id': 'market_value', 'name': 'Market value', 'format': 'currency'}, {'id': 'notes', 'name': 'Notes on the list'}],
      'rules': ['names_covered = COUNT(tickers.last[covered_by=@person])',
                'positions = COUNT(watchlist.one[owner=@person, status=owned])',
                'market_value = SUM(position.market_value[ticker.covered_by=@person])',
                'notes = COUNT(watchlist.one[owner=@person])'],
    },
  },
  'outputs': [{'pivot': 'position', 'rows': ['ticker'], 'title': 'Positions'},
              {'pivot': 'contributions', 'rows': ['person'], 'cols': ['period'], 'lines': ['trades_entered'], 'title': 'Trades entered per person'}],
  'dashboards': [
    {'id': 'desk', 'name': 'The desk', 'theme': 'banking', 'cards': [
      {'kind': 'links'},
      {'kind': 'text', 'text': 'Every row in the blotter and on the watchlist carries the person who entered it and the person who last changed it. '
                               'The engine fills those columns; nobody types them, and a client that sends them is ignored. '
                               'They are ordinary fields, so the Activity page charts them like any other dimension.'},
      {'kind': 'kpi', 'pivot': 'fund', 'line': 'market_value', 'title': 'Market value'},
      {'kind': 'kpi', 'pivot': 'fund', 'line': 'unrealised', 'title': 'Unrealised gain'},
      {'kind': 'kpi', 'pivot': 'fund', 'line': 'names', 'title': 'Names held'},
      {'kind': 'table', 'pivot': 'position', 'rows': ['ticker'], 'cols': ['line'], 'title': 'Positions', 'sort': '-market_value', 'hideZeroRows': True},
      {'kind': 'chart', 'type': 'bar', 'pivot': 'coverage', 'rows': ['line'], 'cols': ['person'], 'lines': ['market_value'], 'title': 'The book, by the analyst who covers it', 'w': 4},
      {'kind': 'chart', 'type': 'bar', 'pivot': 'position', 'rows': ['line'], 'cols': ['ticker'], 'lines': ['market_value'], 'title': 'Market value by name', 'w': 4},
      {'kind': 'chart', 'type': 'bar', 'pivot': 'position', 'rows': ['line'], 'cols': ['ticker'], 'lines': ['unrealised'], 'title': 'Unrealised gain by name', 'w': 4},
      {'kind': 'data', 'table': 'trades', 'title': 'The blotter, newest first',
       'fields': ['date', 'ticker', 'side', 'quantity', 'price', 'value', 'added_by', 'added_at', 'changed_by', 'changed_at', 'note'],
       'sort': '-date', 'limit': 50, 'h': 10},
    ]},
    {'id': 'activity', 'name': 'Who did what', 'theme': 'banking', 'cards': [
      {'kind': 'links'},
      {'kind': 'text', 'text': '**The desk\'s own record.** `added_by` and `changed_by` reference the people table the engine keeps, '
                               'so contributions pivot like any other dimension. The log behind them keeps every change ever made, '
                               'including the ones since overwritten.'},
      {'kind': 'chart', 'type': 'stackedBar', 'pivot': 'contributions', 'rows': ['person'], 'cols': ['period'], 'pages': {'line': 'trades_entered'}, 'title': 'Trades by month, and who entered them', 'w': 6},
      {'kind': 'chart', 'type': 'stackedBar', 'pivot': 'contributions', 'rows': ['person'], 'cols': ['period'], 'pages': {'line': 'traded_value'}, 'title': 'Value traded by month, and who entered it', 'w': 6},
      {'kind': 'table', 'pivot': 'coverage', 'rows': ['person'], 'cols': ['line'], 'title': 'By analyst', 'sort': '-market_value'},
      {'kind': 'data', 'table': 'watchlist', 'title': 'The watchlist: whose note, and when it was last touched',
       'fields': ['ticker', 'status', 'owner', 'note', 'added_by', 'added_at', 'changed_by', 'changed_at'], 'sort': '-changed_at', 'limit': 50, 'h': 9},
    ]},
  ],
}

out = os.path.join(HERE, '..', 'trade-desk.json')
with open(out, 'w') as fh: json.dump(doc, fh, indent=1, ensure_ascii=False); fh.write('\n')
print('wrote', os.path.normpath(out), f'{os.path.getsize(out) / 1024:.0f} KB; {len(TRADES)} trades, {len(WATCH)} watchlist rows, {len(PEOPLE)} people')
