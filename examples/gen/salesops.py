#!/usr/bin/env python3
"""Generates examples/salesops.json: a sales operations model for a ~$60M ARR B2B SaaS company.

The data is synthetic but not uniform. Deal sizes are lognormal (a power-law-like tail: a few very large
deals), account sizes are Pareto within each segment, rep skill is lognormal and drives win rate, deal
size and volume, sales cycles are normal per segment, activity counts are normal, conversions are
binomial, churn is heavy-tailed, and closes cluster at quarter ends. Marketing leads -> MQLs -> SQLs and
BDR activity -> meetings -> SQLs are generated top-down so the funnel, the opportunity table and the
bookings all agree.

Run: python3 examples/gen/salesops.py  (deterministic; seed below)
"""
import json, math, random, datetime as dt
from collections import defaultdict

SEED = 20260919
TODAY = dt.date(2026, 9, 19)
LAST_ACTUAL = TODAY   # deals with a close date up to today are resolved; later ones are open pipeline
rng = random.Random(SEED)
import os
VOLUME = float(os.environ.get('SALESOPS_VOLUME', '0.8'))   # scales lead volume, BDR activity and referrals; calibrated below

# ---------------------------------------------------------------- calendar
MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
def pid(y, m): return f'{MON[m-1]}{str(y)[2:]}'
MONTHS = [(2025, m) for m in range(4, 13)] + [(2026, m) for m in range(1, 13)]
PERIOD_IDS = [pid(y, m) for y, m in MONTHS]
def qlabel(y, m): return f'Q{(m - 1) // 3 + 1} {y}'
QUARTERS = [(f'q{q}_2025', f'Q{q} 2025', 2025, [(2025, 3 * (q - 1) + k) for k in (1, 2, 3)]) for q in range(2, 5)] + [(f'q{q}_2026', f'Q{q} 2026', 2026, [(2026, 3 * (q - 1) + k) for k in (1, 2, 3)]) for q in range(1, 5)]
def quarter_of(y, m): return f'q{(m - 1) // 3 + 1}_{y}'

# ---------------------------------------------------------------- distributions
def poisson(lam):
    if lam <= 0: return 0
    if lam > 60: return max(0, int(round(rng.gauss(lam, math.sqrt(lam)))))
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        k += 1; p *= rng.random()
        if p <= L: return k - 1
def binomial(n, p):
    if n <= 0 or p <= 0: return 0
    if n > 80: return max(0, min(n, int(round(rng.gauss(n * p, math.sqrt(n * p * (1 - p)))))))
    return sum(1 for _ in range(n) if rng.random() < p)
def lognormal(median, sigma): return median * math.exp(rng.gauss(0, sigma))
def normal(mu, sd, lo=None):
    x = rng.gauss(mu, sd)
    return x if lo is None else max(lo, x)
def pareto_between(lo, hi, alpha):
    while True:
        x = lo * rng.paretovariate(alpha)
        if x <= hi: return x

# ---------------------------------------------------------------- org
REGIONS = [('amer_east', 'AMER East', 1.2), ('amer_west', 'AMER West', 1.1), ('emea', 'EMEA', 0.95), ('apac', 'APAC', 0.6)]
REGION_QUOTA = dict(amer_east=1.0, amer_west=1.0, emea=0.9, apac=0.7)   # quota scales with market size; OTE does not, so smaller markets carry a higher rate
SEGMENTS = {  # id: name, min employees, max, annual quota, OTE, variable, opps λ per rep-month, acv median, acv sigma, base win, cycle mean, cycle sd
    'enterprise': dict(name='Enterprise', emp=(2500, 200000, 1.15), quota=1500000, ote=300000, variable=150000, lam=3.0, acv=(150000, 0.55), win=0.24, cycle=(115, 35, 30), share=0.18),
    'mid_market': dict(name='Mid-Market', emp=(250, 2499, 1.3), quota=850000, ote=220000, variable=110000, lam=6.0, acv=(48000, 0.55), win=0.28, cycle=(58, 18, 14), share=0.37),
    'smb': dict(name='SMB', emp=(20, 249, 1.1), quota=450000, ote=160000, variable=80000, lam=8.0, acv=(15000, 0.5), win=0.33, cycle=(28, 10, 7), share=0.45),
}
CHANNELS = [('inbound', 'Inbound (web & content)', 'marketing'), ('paid', 'Paid digital', 'marketing'), ('events', 'Events & field', 'marketing'), ('partner', 'Partner', 'marketing'), ('outbound', 'Outbound (BDR)', 'sales'), ('referral', 'Customer referral', 'sales')]
CHANNEL_WIN = dict(inbound=1.2, paid=0.85, events=1.0, partner=1.15, outbound=0.75, referral=1.35)
INDUSTRIES = [('software', 'Software', 0.2), ('financial_services', 'Financial services', 0.15), ('healthcare', 'Healthcare', 0.12), ('manufacturing', 'Manufacturing', 0.12), ('retail', 'Retail & e-commerce', 0.1), ('logistics', 'Logistics', 0.08), ('media', 'Media', 0.06), ('energy', 'Energy & utilities', 0.06), ('public_sector', 'Public sector', 0.05), ('education', 'Education', 0.06)]
STAGES = [('discovery', 'Discovery', 1, 0.10), ('evaluation', 'Evaluation', 2, 0.25), ('proposal', 'Proposal', 3, 0.50), ('negotiation', 'Negotiation', 4, 0.75), ('closed_won', 'Closed won', 5, 1.0), ('closed_lost', 'Closed lost', 6, 0.0)]

FIRST = ['Ana', 'Marcus', 'Priya', 'Diego', 'Hannah', 'Kenji', 'Fatima', 'Liam', 'Sofia', 'Tobias', 'Amara', 'Wei', 'Elena', 'Jamal', 'Ingrid', 'Rafael', 'Mei', 'Owen', 'Zara', 'Nikolai', 'Chloe', 'Arjun', 'Lucia', 'Samuel', 'Noor', 'Mateo', 'Yuki', 'Grace', 'Emeka', 'Isabel', 'Hugo', 'Leila']
LAST = ['Ortiz', 'Chen', 'Patel', 'Novak', 'Okafor', 'Silva', 'Müller', 'Tanaka', 'Haddad', 'Larsen', 'Reyes', 'Kim', 'Dubois', 'Nakamura', 'Ivanova', 'Mensah', 'Rossi', 'Schmidt', 'Almeida', 'Park', 'Fischer', 'Rahman', 'Moreau', 'Osei', 'Kowalski', 'Sato', 'Lindqvist', 'Costa', 'Nair', 'Brennan', 'Castillo', 'Yilmaz']
names_used = set()
def person():
    while True:
        n = f'{rng.choice(FIRST)} {rng.choice(LAST)}'
        if n not in names_used: names_used.add(n); return n

managers = [
    dict(id='m_amer_east', name=person(), title='Regional Director, AMER East', region='amer_east'),
    dict(id='m_amer_west', name=person(), title='Regional Director, AMER West', region='amer_west'),
    dict(id='m_emea', name=person(), title='Regional Director, EMEA', region='emea'),
    dict(id='m_apac', name=person(), title='Regional Director, APAC', region='apac'),
    dict(id='vp_sales', name=person(), title='VP Sales', region='amer_east'),
    dict(id='cro', name=person(), title='Chief Revenue Officer', region='amer_east'),
]

# 24 AEs: two per region per segment. Four are ramping (hired inside the window).
reps = []
hires = {('emea', 'enterprise', 1): '2025-11-01', ('amer_west', 'mid_market', 1): '2026-02-01', ('apac', 'smb', 0): '2026-04-01', ('amer_east', 'enterprise', 1): '2026-07-01'}
tenured_starts = ['2022-03-01', '2023-01-01', '2023-06-01', '2024-02-01', '2024-09-01', '2021-11-01', '2022-08-01', '2023-10-01', '2024-05-01', '2025-03-01', '2025-06-01']
n = 0
for rid, _, _ in REGIONS:
    for seg, s in SEGMENTS.items():
        for k in range(2):
            n += 1
            start = hires.get((rid, seg, k)) or tenured_starts[(n * 7) % len(tenured_starts)]
            skill = lognormal(1.0, 0.12)
            quota = round(s['quota'] * REGION_QUOTA[rid], -4)
            reps.append(dict(id=f'r{n:02d}', name=person(), region=rid, segment=seg, manager=f'm_{rid}', start=start, ote=s['ote'], variable=s['variable'], annual_quota=quota, base_rate=round(s['variable'] / quota, 4), _skill=skill))

# 8 SDRs: one inbound SDR and one outbound BDR per region
sdrs = []
for rid, rname, _ in REGIONS:
    sdrs.append(dict(id=f's_{rid}_in', name=person(), region=rid, kind='SDR (inbound)', manager=f'm_{rid}', sql_quota=10, _skill=lognormal(1.0, 0.15)))
    sdrs.append(dict(id=f's_{rid}_out', name=person(), region=rid, kind='BDR (outbound)', manager=f'm_{rid}', sql_quota=6, _skill=lognormal(1.0, 0.15)))

def tenure_months(start_iso, y, m):
    sy, sm, _ = map(int, start_iso.split('-'))
    return (y - sy) * 12 + (m - sm)
def ramp(months):  # quota ramp by tenure at quarter start
    return 0.25 if months < 3 else 0.5 if months < 6 else 0.75 if months < 9 else 1.0

# ---------------------------------------------------------------- accounts
ADJ = ['Northwind', 'Blue Harbor', 'Summit', 'Vertex', 'Granite', 'Silverline', 'Cascade', 'Pioneer', 'Atlas', 'Meridian', 'Lakeside', 'Redwood', 'Ironbridge', 'Beacon', 'Horizon', 'Copper', 'Evergreen', 'Keystone', 'Nimbus', 'Orchard', 'Quantum', 'Sable', 'Tidewater', 'Umber', 'Juniper', 'Falcon', 'Harbor', 'Cobalt', 'Aurora', 'Brightwater']
NOUN = ['Logistics', 'Health', 'Financial', 'Systems', 'Foods', 'Analytics', 'Energy', 'Media', 'Retail', 'Robotics', 'Labs', 'Manufacturing', 'Insurance', 'Networks', 'Mobility', 'Biotech', 'Capital', 'Software', 'Materials', 'Learning']
SUFFIX = ['', '', '', ' Group', ' Inc', ' Ltd', ' Holdings', ' Partners', ' Co', ' AG', ' SA']
acct_names = set()
accounts = []
def new_account(region, segment):
    while True:
        nm = f'{rng.choice(ADJ)} {rng.choice(NOUN)}{rng.choice(SUFFIX)}'
        if nm not in acct_names: acct_names.add(nm); break
    lo, hi, alpha = SEGMENTS[segment]['emp']
    ind = rng.choices([i[0] for i in INDUSTRIES], [i[2] for i in INDUSTRIES])[0]
    a = dict(id=f'a{len(accounts)+1:04d}', name=nm, industry=ind, region=region, segment=segment, employees=int(pareto_between(lo, hi, alpha)))
    accounts.append(a); return a

# ---------------------------------------------------------------- marketing funnel (top-down)
CH_PARAMS = dict(  # spend per region-month base, CPL, lead->MQL, MQL->SQL
    inbound=dict(spend=15000, cpl=45, mql=0.16, sql=0.18), paid=dict(spend=45000, cpl=150, mql=0.11, sql=0.15),
    events=dict(spend=27000, cpl=400, mql=0.32, sql=0.22), partner=dict(spend=6000, cpl=250, mql=0.38, sql=0.35))
EVENT_MONTHS = {(2025, 5): 1.5, (2025, 10): 1.6, (2026, 3): 1.6, (2026, 6): 1.5, (2026, 10): 1.7, (2026, 11): 1.3}
marketing = []
sqls_by = defaultdict(int)  # (channel, region, y, m) -> SQL count = opportunities created
for ch, cp in CH_PARAMS.items():
    for rid, _, rw in REGIONS:
        for y, m in MONTHS:
            season = 1.0 + 0.12 * math.sin((m - 1) / 12 * 2 * math.pi) + (0.15 if m in (3, 6, 9, 12) else 0)
            if ch == 'events': season *= EVENT_MONTHS.get((y, m), 0.45)
            if ch == 'paid' and y == 2026 and m >= 5: season *= 1.15   # budget step-up in May
            spend = cp['spend'] * rw * season * lognormal(1, 0.08) * VOLUME
            leads = int(spend / cp['cpl'] * lognormal(1, 0.2))
            mqls = binomial(leads, cp['mql'])
            sqls = binomial(mqls, cp['sql'])
            marketing.append(dict(id=f'mk_{ch}_{rid}_{pid(y, m)}', channel=ch, region=rid, period=pid(y, m), spend=round(spend, -1), leads=leads, mqls=mqls))
            sqls_by[(ch, rid, y, m)] = sqls

# ---------------------------------------------------------------- SDR activity (top-down for BDRs, back-filled for inbound SDRs)
sdr_activity = []
outbound_sqls = defaultdict(int)  # (sdr, y, m)
for s in sdrs:
    for y, m in MONTHS:
        tm = 12 + tenure_months('2025-01-01', y, m)
        season = 0.8 if m in (12, 8) else 1.0
        if s['kind'].startswith('BDR'):
            calls = int(normal(850, 110) * s['_skill'] ** 0.5 * season * VOLUME)
            emails = int(normal(1400, 200) * season)
            connects = binomial(calls, 0.09 * s['_skill'] ** 0.3)
            met_set = binomial(connects, 0.19 * s['_skill'] ** 0.5)
            held = binomial(met_set, 0.78)
            sqls = binomial(held, 0.65)
            outbound_sqls[(s['id'], y, m)] = sqls
        else:
            sqls = sum(sqls_by[(ch, s['region'], y, m)] for ch in ('inbound', 'paid'))
            held = sqls + binomial(sqls, 0.45)
            met_set = held + binomial(held, 0.28)
            connects = met_set + int(met_set * normal(4.5, 0.8, 2))
            calls = int(connects / max(0.05, min(0.35, normal(0.18, 0.03))))
            emails = int(calls * normal(1.6, 0.2, 0.8))
        sdr_activity.append(dict(id=f'act_{s["id"]}_{pid(y, m)}', sdr=s['id'], period=pid(y, m), calls=calls, emails=emails, connects=connects, meetings_set=met_set, meetings_held=held, sqls=sqls))

# ---------------------------------------------------------------- opportunities
def pick_rep(region, segment, y, m):
    cands = [r for r in reps if r['region'] == region and r['segment'] == segment]
    w = []
    for r in cands:
        t = tenure_months(r['start'], y, m)
        w.append(0 if t < 0 else ramp(t) * r['_skill'] ** 0.3)
    if sum(w) == 0: return None
    return rng.choices(cands, w)[0]

def segment_for(region):
    return rng.choices(list(SEGMENTS), [s['share'] for s in SEGMENTS.values()])[0]

opps = []
existing_customers = []  # accounts that have a won deal (for expansion opportunities)
def make_opp(region, channel, y, m, sdr=None, segment=None):
    segment = segment or segment_for(region)
    rep = pick_rep(region, segment, y, m)
    if rep is None: return
    s = SEGMENTS[segment]
    expansion = existing_customers and rng.random() < 0.3
    if expansion:
        acct = rng.choice([a for a in existing_customers if a['region'] == region] or existing_customers)
        segment = acct['segment']; s = SEGMENTS[segment]
        rep = pick_rep(region, segment, y, m) or rep
    else:
        acct = new_account(region, segment)
    med, sig = s['acv']
    acv = lognormal(med, sig) * rep['_skill'] ** 0.2 * (acct['employees'] / math.sqrt(s['emp'][0] * min(s['emp'][1], s['emp'][0] * 12))) ** 0.2
    if expansion: acv *= 0.45
    acv = max(2500, min(round(acv, -2), dict(enterprise=700000, mid_market=200000, smb=60000)[segment]))   # the tail is long, not unbounded
    term = rng.choices([1, 2, 3], dict(enterprise=[0.4, 0.35, 0.25], mid_market=[0.7, 0.25, 0.05], smb=[0.92, 0.07, 0.01])[segment])[0]
    created = dt.date(y, m, min(28, 1 + int(rng.random() * 28)))
    if created > TODAY: return
    cm, cs, cmin = s['cycle']
    cycle = int(normal(cm, cs, cmin))
    close = created + dt.timedelta(days=cycle)
    if close.month % 3 != 0 and rng.random() < 0.2:   # slips to quarter end
        qend_m = ((close.month - 1) // 3 + 1) * 3
        close = dt.date(close.year, qend_m, 28); cycle = (close - created).days
    if close > dt.date(2026, 12, 31): close = dt.date(2026, 12, 15); cycle = (close - created).days
    p_win = min(0.85, s['win'] * CHANNEL_WIN[channel] * rep['_skill'] ** 0.5 * (1.4 if expansion else 1.0))
    if close <= LAST_ACTUAL:
        won = rng.random() < p_win
        stage = 'closed_won' if won else 'closed_lost'
        if won and not expansion: existing_customers.append(acct)
    else:
        progress = (TODAY - created).days / max(cycle, 1)
        order = ['discovery', 'evaluation', 'proposal', 'negotiation']
        k = 0 if progress < 0.35 else 1 if progress < 0.6 else 2 if progress < 0.85 else 3
        if rng.random() < 0.45: k = max(0, k - 1)   # deals stall a stage behind their calendar
        stage = order[k]
        # the close date in the CRM is the rep's, and reps are optimistic: it lands before the true close, never before today
        planned = created + dt.timedelta(days=int(cycle * rng.uniform(0.55, 1.0)))
        if planned <= TODAY: planned = TODAY + dt.timedelta(days=int(rng.uniform(5, 45)))
        if planned.month % 3 == 0 or rng.random() < 0.35:   # and it clusters at quarter ends
            qend_m = ((planned.month - 1) // 3 + 1) * 3
            planned = dt.date(planned.year, qend_m, 28) if dt.date(planned.year, qend_m, 28) >= TODAY else planned
        close = min(planned, dt.date(2026, 12, 15))
    opps.append(dict(id=f'o{len(opps)+1:04d}', account=acct['id'], rep=rep['id'], sdr=sdr, channel=channel, stage=stage, new_logo=0 if expansion else 1,
                     acv=acv, term_years=term, security_addon=1 if rng.random() < 0.28 else 0, created=created.isoformat(), close=close.isoformat(),
                     created_period=pid(created.year, created.month), close_period=pid(close.year, close.month), cycle_days=cycle,
                     won=1 if stage == 'closed_won' else 0, lost=1 if stage == 'closed_lost' else 0, open=0 if stage.startswith('closed') else 1))

for y, m in MONTHS:
    for rid, _, rw in REGIONS:
        for ch in ('inbound', 'paid', 'events', 'partner'):
            for _ in range(sqls_by[(ch, rid, y, m)]): make_opp(rid, ch, y, m, sdr=f's_{rid}_in' if ch in ('inbound', 'paid') else None)
        for _ in range(outbound_sqls[(f's_{rid}_out', y, m)]): make_opp(rid, 'outbound', y, m, sdr=f's_{rid}_out')
        for _ in range(poisson(2.2 * rw * VOLUME)): make_opp(rid, 'referral', y, m)
rng.shuffle(opps)
for i, o in enumerate(opps): o['id'] = f'o{i+1:04d}'
# sdr None -> omit the key
for o in opps:
    if o['sdr'] is None: del o['sdr']

# ---------------------------------------------------------------- quotas (ramped for new hires)
quota_plan = []
for r in reps:
    for qid, _, qy, months in QUARTERS:
        y, m = months[0]
        t = tenure_months(r['start'], y, m)
        q = 0 if t < 0 else r['annual_quota'] / 4 * ramp(t)
        quota_plan.append(dict(at=dict(rep=r['id'], quarter=qid, line='quota'), value=round(q, -3)))

# ---------------------------------------------------------------- churn (heavy-tailed)
REASONS = ['Budget cut', 'Lost champion', 'Consolidated vendors', 'Moved to competitor', 'Acquired', 'Low adoption']
churn = []
for y, m in MONTHS:
    if (y, m) > (2026, 8): break
    for k in range(poisson(5.0)):
        churn.append(dict(id=f'ch_{pid(y, m)}_{k+1}', period=pid(y, m), account=rng.choice(accounts)['id'] if accounts else None, arr_lost=round(lognormal(30000, 1.0), -2), reason=rng.choice(REASONS)))

# ---------------------------------------------------------------- summary for calibration
ytd_ids = [pid(2026, m) for m in range(1, 10)]
won26 = sum(o['acv'] for o in opps if o['won'] and o['close_period'] in ytd_ids)
quota26 = sum(v['value'] for v in quota_plan if v['at']['quarter'] in ('q1_2026', 'q2_2026')) + sum(v['value'] for v in quota_plan if v['at']['quarter'] == 'q3_2026') * 81 / 92
print(f'YTD 2026 attainment {won26 / quota26:.2f} (bookings ${won26:,.0f} vs prorated quota ${quota26:,.0f}) at VOLUME={VOLUME}; suggested VOLUME={VOLUME * 0.92 / (won26 / quota26):.3f}')
print(f'opps {len(opps)}  accounts {len(accounts)}  won {sum(o["won"] for o in opps)}  lost {sum(o["lost"] for o in opps)}  open {sum(o["open"] for o in opps)}')
by_rep = defaultdict(float)
for o in opps:
    if o['won'] and o['close_period'] in ytd_ids: by_rep[o['rep']] += o['acv']
att = sorted(round(by_rep[r['id']] / max(1, sum(v['value'] for v in quota_plan if v['at']['rep'] == r['id'] and v['at']['quarter'] in ('q1_2026', 'q2_2026', 'q3_2026'))), 2) for r in reps)
print('YTD attainment by rep:', att)
print('largest deals:', sorted((o['acv'] for o in opps), reverse=True)[:5], ' median', sorted(o['acv'] for o in opps)[len(opps) // 2])

# ---------------------------------------------------------------- the document
def strip(rows): return [{k: v for k, v in r.items() if not k.startswith('_')} for r in rows]
def L(id, name, fmt=None):
    d = dict(id=id, name=name)
    if fmt: d['format'] = fmt
    return d
PCT = 'percent'

doc = {
  'model': 'salesops',
  'name': 'Meridian Software — sales operations, FY2026',
  'units': 'USD',
  'periods': {'start': '2025-04', 'count': 21, 'grain': 'month'},
  'tables': {
    'quarters': {'name': 'Quarters', 'rows': [dict(id=qid, name=lbl, label=lbl, year=qy, spiff_active=1 if qid == 'q3_2026' else 0, is_future=1 if months[0] > (TODAY.year, TODAY.month) else 0) for qid, lbl, qy, months in QUARTERS]},
    'regions': {'name': 'Regions', 'rows': [dict(id=i, name=nm) for i, nm, _ in REGIONS]},
    'segments': {'name': 'Segments', 'rows': [dict(id=i, name=s['name'], annual_quota=s['quota'], ote=s['ote']) for i, s in SEGMENTS.items()]},
    'managers': {'name': 'Sales leadership', 'fields': {'region': 'ref:regions'}, 'rows': managers},
    'reps': {'name': 'Account executives', 'fields': {'region': 'ref:regions', 'segment': 'ref:segments', 'manager': 'ref:managers', 'start': 'date', 'ote': 'number', 'variable': 'number', 'annual_quota': 'number', 'base_rate': 'number'}, 'rows': strip(reps)},
    'sdrs': {'name': 'SDRs and BDRs', 'fields': {'region': 'ref:regions', 'manager': 'ref:managers', 'sql_quota': 'number'}, 'rows': strip(sdrs)},
    'channels': {'name': 'Channels', 'rows': [dict(id=i, name=nm, kind=k) for i, nm, k in CHANNELS]},
    'industries': {'name': 'Industries', 'rows': [dict(id=i, name=nm) for i, nm, _ in INDUSTRIES]},
    'stages': {'name': 'Stages', 'rows': [dict(id=i, name=nm, order=o, probability=p) for i, nm, o, p in STAGES]},
    'tranches': {'name': 'Commission tranches', 'rows': [dict(id='t1', name='Below 50%'), dict(id='t2', name='50% to 100%'), dict(id='t3', name='100% to 125%'), dict(id='t4', name='125% to 150%'), dict(id='t5', name='Above 150%'), dict(id='total', name='Total')]},
    'accounts': {'name': 'Accounts', 'fields': {'industry': 'ref:industries', 'region': 'ref:regions', 'segment': 'ref:segments', 'employees': 'number'}, 'rows': accounts},
    'opps': {'name': 'Opportunities', 'fields': {'account': 'ref:accounts', 'rep': 'ref:reps', 'sdr': 'ref:sdrs', 'channel': 'ref:channels', 'stage': 'ref:stages', 'new_logo': 'number', 'acv': 'number', 'term_years': 'number', 'security_addon': 'number', 'created': 'date', 'close': 'date', 'created_period': 'ref:periods', 'close_period': 'ref:periods', 'cycle_days': 'number', 'won': 'number', 'lost': 'number', 'open': 'number', 'weighted_acv': 'number*', 'tcv': 'number*', 'extra_year_acv': 'number*', 'region': 'ref:regions*', 'segment': 'ref:segments*', 'close_quarter': 'text*'},
             'rows': opps, 'rules': ['weighted_acv = acv * stage.probability', 'tcv = acv * term_years', 'extra_year_acv = acv * (term_years - 1)', 'region = rep.region', 'segment = rep.segment', 'close_quarter = SUBSTITUTE(LOWER(close_period.quarter), " ", "_")']},
    'marketing': {'name': 'Marketing spend and leads', 'fields': {'channel': 'ref:channels', 'region': 'ref:regions', 'period': 'ref:periods', 'spend': 'number', 'leads': 'number', 'mqls': 'number'}, 'rows': marketing},
    'sdr_activity': {'name': 'SDR activity', 'fields': {'sdr': 'ref:sdrs', 'period': 'ref:periods', 'calls': 'number', 'emails': 'number', 'connects': 'number', 'meetings_set': 'number', 'meetings_held': 'number', 'sqls': 'number'}, 'rows': sdr_activity},
    'churn': {'name': 'Churn events', 'fields': {'period': 'ref:periods', 'account': 'ref:accounts', 'arr_lost': 'number'}, 'rows': churn},
  },
  'pivots': {
    'plan': {'name': 'Plan parameters', 'dims': {'period': False},
      'lines': [L('starting_arr', 'ARR at 31 Mar 2025'), L('new_logo_rate', 'New-logo kicker (% of new-logo ACV)', PCT), L('multiyear_rate', 'Multi-year kicker (% of ACV per extra year)', PCT), L('spiff_amount', 'Security add-on SPIFF ($ per deal, Q3 2026)'), L('cap_multiple', 'Payout cap (× on-target variable)'), L('commit_weight', 'Forecast weight: commit', PCT), L('best_case_weight', 'Forecast weight: best case', PCT), L('pipeline_weight', 'Forecast weight: pipeline', PCT)],
      'values': [dict(at=dict(line='starting_arr'), value=52600000), dict(at=dict(line='new_logo_rate'), value=0.015), dict(at=dict(line='multiyear_rate'), value=0.01), dict(at=dict(line='spiff_amount'), value=2000), dict(at=dict(line='cap_multiple'), value=3.0), dict(at=dict(line='commit_weight'), value=0.9), dict(at=dict(line='best_case_weight'), value=0.5), dict(at=dict(line='pipeline_weight'), value=0.1)]},
    'comp_plan': {'name': 'Commission plan', 'dims': {'tranche': 'tranches', 'period': False},
      'lines': [L('from_pct', 'Attainment from', PCT), L('to_pct', 'Attainment to', PCT), L('multiplier', 'Rate multiplier (x)')],
      'values': [dict(at=dict(tranche=t, line=l), value=v) for t, (a, b, x) in dict(t1=(0, 0.5, 0.75), t2=(0.5, 1.0, 1.0), t3=(1.0, 1.25, 1.5), t4=(1.25, 1.5, 2.0), t5=(1.5, 9.99, 3.0)).items() for l, v in (('from_pct', a), ('to_pct', b), ('multiplier', x))]},
    'quota_plan': {'name': 'Quota plan', 'dims': {'rep': 'reps', 'quarter': 'quarters', 'period': False}, 'lines': [L('quota', 'Quarterly quota')], 'values': quota_plan},
    'funnel': {'name': 'Marketing funnel by channel and region', 'dims': {'channel': 'channels', 'region': 'regions'},
      'lines': [L('spend', 'Spend'), L('leads', 'Leads'), L('mqls', 'MQLs'), L('opps_created', 'Opportunities created (SQLs)'), L('pipeline_created', 'Pipeline created'), L('deals_won', 'Deals won'), L('won_acv', 'Bookings'), L('cost_per_lead', 'Cost per lead'), L('mql_rate', 'Lead to MQL', PCT), L('sql_rate', 'MQL to SQL', PCT), L('cost_per_opp', 'Cost per opportunity'), L('pipeline_per_dollar', 'Pipeline per $ of spend')],
      'rules': ['spend = SUM(marketing.spend)', 'leads = SUM(marketing.leads)', 'mqls = SUM(marketing.mqls)',
                'opps_created = COUNT(opps.acv[channel=@channel, region=@region, created_period=@period])',
                'pipeline_created = SUM(opps.acv[channel=@channel, region=@region, created_period=@period])',
                'deals_won = COUNT(opps.acv[channel=@channel, region=@region, close_period=@period, won=1])',
                'won_acv = SUM(opps.acv[channel=@channel, region=@region, close_period=@period, won=1])',
                'cost_per_lead = IF(leads > 0, spend / leads, BLANK)', 'mql_rate = IF(leads > 0, mqls / leads, BLANK)', 'sql_rate = IF(mqls > 0, opps_created / mqls, BLANK)',
                'cost_per_opp = IF(opps_created > 0, spend / opps_created, BLANK)', 'pipeline_per_dollar = IF(spend > 0, pipeline_created / spend, BLANK)']},
    'channel_summary': {'name': 'Marketing funnel by channel', 'dims': {'channel': 'channels'},
      'lines': [L('spend', 'Spend'), L('leads', 'Leads'), L('mqls', 'MQLs'), L('opps_created', 'Opportunities created (SQLs)'), L('pipeline_created', 'Pipeline created'), L('deals_won', 'Deals won'), L('won_acv', 'Bookings'), L('cost_per_lead', 'Cost per lead'), L('mql_rate', 'Lead to MQL', PCT), L('sql_rate', 'MQL to SQL', PCT), L('win_rate', 'SQL to won', PCT), L('cost_per_opp', 'Cost per opportunity'), L('pipeline_per_dollar', 'Pipeline per $ of spend'), L('cac_ratio', 'Bookings per $ of spend')],
      'rules': ['spend = SUM(funnel.spend)', 'leads = SUM(funnel.leads)', 'mqls = SUM(funnel.mqls)', 'opps_created = SUM(funnel.opps_created)', 'pipeline_created = SUM(funnel.pipeline_created)', 'deals_won = SUM(funnel.deals_won)', 'won_acv = SUM(funnel.won_acv)',
                'cost_per_lead = IF(leads > 0, spend / leads, BLANK)', 'mql_rate = IF(leads > 0, mqls / leads, BLANK)', 'sql_rate = IF(mqls > 0, opps_created / mqls, BLANK)',
                'win_rate = IF(opps_created > 0, deals_won / opps_created, BLANK)',
                'cost_per_opp = IF(opps_created > 0, spend / opps_created, BLANK)', 'pipeline_per_dollar = IF(spend > 0, pipeline_created / spend, BLANK)', 'cac_ratio = IF(spend > 0, won_acv / spend, BLANK)']},
    'sdr_scorecard': {'name': 'SDR and BDR scorecard', 'dims': {'sdr': 'sdrs'},
      'lines': [L('calls', 'Calls'), L('emails', 'Emails'), L('connects', 'Connects'), L('meetings_set', 'Meetings set'), L('meetings_held', 'Meetings held'), L('sqls', 'SQLs'), L('sql_quota', 'SQL quota'), L('attainment', 'SQL attainment', PCT), L('connect_rate', 'Connect rate', PCT), L('set_rate', 'Meetings per connect', PCT), L('show_rate', 'Show rate', PCT), L('opps_sourced', 'Opportunities sourced'), L('pipeline_sourced', 'Pipeline sourced'), L('won_sourced', 'Sourced bookings (closed this month)'), L('pipeline_per_sql', 'Pipeline per SQL')],
      'rules': ['calls = SUM(sdr_activity.calls)', 'emails = SUM(sdr_activity.emails)', 'connects = SUM(sdr_activity.connects)', 'meetings_set = SUM(sdr_activity.meetings_set)', 'meetings_held = SUM(sdr_activity.meetings_held)', 'sqls = SUM(sdr_activity.sqls)',
                'sql_quota = sdr.sql_quota', 'attainment = IFERROR(sqls / sql_quota, 0)', 'connect_rate = IFERROR(connects / calls, 0)', 'set_rate = IFERROR(meetings_set / connects, 0)', 'show_rate = IFERROR(meetings_held / meetings_set, 0)',
                'opps_sourced = COUNT(opps.acv[sdr=@sdr, created_period=@period])', 'pipeline_sourced = SUM(opps.acv[sdr=@sdr, created_period=@period])', 'won_sourced = SUM(opps.acv[sdr=@sdr, close_period=@period, won=1])', 'pipeline_per_sql = IFERROR(pipeline_sourced / sqls, 0)']},
    'rep_monthly': {'name': 'Rep monthly', 'dims': {'rep': 'reps'},
      'lines': [L('bookings', 'Bookings'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('new_logo_bookings', 'New-logo bookings'), L('expansion_bookings', 'Expansion bookings'), L('opps_created', 'Opportunities created'), L('pipeline_created', 'Pipeline created'), L('open_pipeline', 'Open pipeline closing this month'), L('commit', 'Commit (negotiation)'), L('best_case', 'Best case (proposal)'), L('weighted_pipeline', 'Weighted pipeline'), L('forecast', 'Forecast')],
      'rules': ['bookings = SUM(opps.acv[rep=@rep, close_period=@period, won=1])', 'deals_won = COUNT(opps.acv[rep=@rep, close_period=@period, won=1])', 'deals_lost = COUNT(opps.acv[rep=@rep, close_period=@period, lost=1])',
                'new_logo_bookings = SUM(opps.acv[rep=@rep, close_period=@period, won=1, new_logo=1])', 'expansion_bookings = bookings - new_logo_bookings',
                'opps_created = COUNT(opps.acv[rep=@rep, created_period=@period])', 'pipeline_created = SUM(opps.acv[rep=@rep, created_period=@period])',
                'open_pipeline = SUM(opps.acv[rep=@rep, close_period=@period, open=1])', 'commit = SUM(opps.acv[rep=@rep, close_period=@period, open=1, stage=negotiation])', 'best_case = SUM(opps.acv[rep=@rep, close_period=@period, open=1, stage=proposal])',
                'weighted_pipeline = SUM(opps.weighted_acv[rep=@rep, close_period=@period, open=1])',
                'forecast = bookings + plan.commit_weight * commit + plan.best_case_weight * best_case + plan.pipeline_weight * (open_pipeline - commit - best_case)']},
    'rep_quarterly': {'name': 'Rep quarterly', 'dims': {'rep': 'reps', 'quarter': 'quarters', 'period': False},
      'lines': [L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('gap', 'Gap to quota'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('win_rate', 'Win rate', PCT), L('avg_deal', 'Average deal'), L('new_logos', 'New logos'), L('new_logo_bookings', 'New-logo bookings'), L('opps_created', 'Opportunities created'), L('pipeline_created', 'Pipeline created'), L('open_pipeline', 'Open pipeline'), L('commit', 'Commit'), L('best_case', 'Best case'), L('coverage', 'Coverage of gap (x)'), L('forecast', 'Forecast'), L('forecast_attainment', 'Forecast attainment', PCT), L('ytd_bookings', 'YTD bookings'), L('ytd_quota', 'YTD quota'), L('ytd_attainment', 'YTD attainment', PCT)],
      'rules': ['quota = quota_plan.quota', 'bookings = SUM(rep_monthly.bookings[period.quarter=@quarter.label])', 'attainment = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / quota, 0))', 'gap = quota - bookings',
                'deals_won = SUM(rep_monthly.deals_won[period.quarter=@quarter.label])', 'deals_lost = SUM(rep_monthly.deals_lost[period.quarter=@quarter.label])', 'win_rate = IF(quarter.is_future = 1, BLANK, IFERROR(deals_won / (deals_won + deals_lost), 0))', 'avg_deal = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / deals_won, 0))',
                'new_logos = COUNT(opps.acv[rep=@rep, won=1, new_logo=1, close_quarter=@quarter])', 'new_logo_bookings = SUM(rep_monthly.new_logo_bookings[period.quarter=@quarter.label])',
                'opps_created = SUM(rep_monthly.opps_created[period.quarter=@quarter.label])', 'pipeline_created = SUM(rep_monthly.pipeline_created[period.quarter=@quarter.label])',
                'open_pipeline = SUM(rep_monthly.open_pipeline[period.quarter=@quarter.label])', 'commit = SUM(rep_monthly.commit[period.quarter=@quarter.label])', 'best_case = SUM(rep_monthly.best_case[period.quarter=@quarter.label])',
                'coverage = IF(gap > 0 and open_pipeline > 0, open_pipeline / gap, BLANK)', 'forecast = SUM(rep_monthly.forecast[period.quarter=@quarter.label])', 'forecast_attainment = IFERROR(forecast / quota, 0)',
                'ytd_bookings = IF(quarter.year = 2026, SUM(bookings[quarter=q1_2026..this]), bookings)', 'ytd_quota = IF(quarter.year = 2026, SUM(quota[quarter=q1_2026..this]), quota)', 'ytd_attainment = IFERROR(ytd_bookings / ytd_quota, 0)']},
    'commissions': {'name': 'Commission by tranche', 'dims': {'rep': 'reps', 'quarter': 'quarters', 'tranche': 'tranches', 'period': False},
      'lines': [L('attainment', 'Attainment', PCT), L('in_tranche', 'Attainment in tranche', PCT), L('rate', 'Effective rate', PCT), L('commission', 'Commission')],
      'rules': ['attainment = rep_quarterly.attainment',
                'in_tranche = IF(attainment <= comp_plan.from_pct, 0, IF(attainment >= comp_plan.to_pct, comp_plan.to_pct - comp_plan.from_pct, attainment - comp_plan.from_pct))',
                'rate = rep.base_rate * comp_plan.multiplier', 'commission = in_tranche * rep_quarterly.quota * rate',
                'in_tranche[tranche=total] = SUM(in_tranche[tranche != total])', 'rate[tranche=total] = BLANK', 'commission[tranche=total] = SUM(commission[tranche != total])']},
    'payout': {'name': 'Variable pay', 'dims': {'rep': 'reps', 'quarter': 'quarters', 'period': False},
      'lines': [L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('base_commission', 'Commission (tranches)'), L('new_logo_kicker', 'New-logo kicker'), L('multiyear_acv', 'Extra contracted years × ACV'), L('multiyear_kicker', 'Multi-year kicker'), L('spiff_deals', 'Security add-on deals (SPIFF)'), L('spiff', 'SPIFF'), L('uncapped_variable', 'Variable pay before cap'), L('target_variable', 'On-target variable (quarter)'), L('total_variable', 'Total variable pay (capped)'), L('vs_target', 'Variable vs target', PCT), L('effective_rate', 'Pay as % of bookings', PCT), L('ytd_variable', 'YTD variable pay'), L('ytd_attainment', 'YTD attainment', PCT), L('club', "President's Club track (1 = yes)")],
      'rules': ['quota = rep_quarterly.quota', 'bookings = rep_quarterly.bookings', 'attainment = rep_quarterly.attainment', 'base_commission = commissions.commission[tranche=total]',
                'new_logo_kicker = rep_quarterly.new_logo_bookings * plan.new_logo_rate',
                'multiyear_acv = SUM(opps.extra_year_acv[rep=@rep, won=1, close_quarter=@quarter])', 'multiyear_kicker = multiyear_acv * plan.multiyear_rate',
                'spiff_deals = COUNT(opps.acv[rep=@rep, won=1, security_addon=1, close_quarter=@quarter]) * quarter.spiff_active', 'spiff = spiff_deals * plan.spiff_amount',
                'uncapped_variable = base_commission + new_logo_kicker + multiyear_kicker + spiff', 'target_variable = rep.variable / 4', 'total_variable = IF(uncapped_variable > plan.cap_multiple * target_variable, plan.cap_multiple * target_variable, uncapped_variable)', 'vs_target = IFERROR(total_variable / target_variable, 0)', 'effective_rate = IFERROR(total_variable / bookings, 0)',
                'ytd_variable = IF(quarter.year = 2026, SUM(total_variable[quarter=q1_2026..this]), total_variable)', 'ytd_attainment = rep_quarterly.ytd_attainment', 'club = IF(ytd_attainment >= 1, 1, 0)']},
    'team': {'name': 'Team quarterly (region × segment)', 'dims': {'region': 'regions', 'segment': 'segments', 'quarter': 'quarters', 'period': False},
      'lines': [L('rep_count', 'Reps'), L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('bookings_per_rep', 'Bookings per rep'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('win_rate', 'Win rate', PCT), L('avg_deal', 'Average deal'), L('new_logo_bookings', 'New-logo bookings'), L('pipeline_created', 'Pipeline created'), L('open_pipeline', 'Open pipeline'), L('commit', 'Commit'), L('best_case', 'Best case'), L('coverage', 'Coverage of gap (x)'), L('forecast', 'Forecast'), L('forecast_attainment', 'Forecast attainment', PCT), L('variable_pay', 'Variable pay'), L('pay_rate', 'Variable pay as % of bookings', PCT)],
      'rules': ['rep_count = COUNT(reps.annual_quota)'] +
               [f'{l} = SUM(rep_quarterly.{l}[rep.region=@region, rep.segment=@segment])' for l in ('quota', 'bookings', 'deals_won', 'deals_lost', 'new_logo_bookings', 'pipeline_created', 'open_pipeline', 'commit', 'best_case', 'forecast')] +
               ['attainment = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / quota, 0))', 'bookings_per_rep = IFERROR(bookings / rep_count, 0)', 'win_rate = IF(quarter.is_future = 1, BLANK, IFERROR(deals_won / (deals_won + deals_lost), 0))', 'avg_deal = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / deals_won, 0))',
                'coverage = IF(quota - bookings > 0 and open_pipeline > 0, open_pipeline / (quota - bookings), BLANK)', 'forecast_attainment = IFERROR(forecast / quota, 0)',
                'variable_pay = SUM(payout.total_variable[rep.region=@region, rep.segment=@segment])', 'pay_rate = IFERROR(variable_pay / bookings, 0)']},
    'region_quarterly': {'name': 'Region quarterly', 'dims': {'region': 'regions', 'quarter': 'quarters', 'period': False},
      'lines': [L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('forecast', 'Forecast'), L('forecast_attainment', 'Forecast attainment', PCT), L('open_pipeline', 'Open pipeline'), L('coverage', 'Coverage of gap (x)'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('win_rate', 'Win rate', PCT), L('new_logo_bookings', 'New-logo bookings'), L('variable_pay', 'Variable pay')],
      'rules': [f'{l} = SUM(team.{l}[region=@region])' for l in ('quota', 'bookings', 'forecast', 'open_pipeline', 'deals_won', 'deals_lost', 'new_logo_bookings', 'variable_pay')] +
               ['attainment = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / quota, 0))', 'forecast_attainment = IFERROR(forecast / quota, 0)', 'coverage = IF(quota - bookings > 0 and open_pipeline > 0, open_pipeline / (quota - bookings), BLANK)', 'win_rate = IF(quarter.is_future = 1, BLANK, IFERROR(deals_won / (deals_won + deals_lost), 0))']},
    'segment_quarterly': {'name': 'Segment quarterly', 'dims': {'segment': 'segments', 'quarter': 'quarters', 'period': False},
      'lines': [L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('forecast', 'Forecast'), L('forecast_attainment', 'Forecast attainment', PCT), L('open_pipeline', 'Open pipeline'), L('coverage', 'Coverage of gap (x)'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('win_rate', 'Win rate', PCT), L('avg_deal', 'Average deal'), L('new_logo_bookings', 'New-logo bookings'), L('avg_cycle_days', 'Average sales cycle (days, won)')],
      'rules': [f'{l} = SUM(team.{l}[segment=@segment])' for l in ('quota', 'bookings', 'forecast', 'open_pipeline', 'deals_won', 'deals_lost', 'new_logo_bookings')] +
               ['attainment = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / quota, 0))', 'forecast_attainment = IFERROR(forecast / quota, 0)', 'coverage = IF(quota - bookings > 0 and open_pipeline > 0, open_pipeline / (quota - bookings), BLANK)', 'win_rate = IF(quarter.is_future = 1, BLANK, IFERROR(deals_won / (deals_won + deals_lost), 0))', 'avg_deal = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / deals_won, 0))',
                'avg_cycle_days = IFERROR(SUM(opps.cycle_days[segment=@segment, won=1, close_quarter=@quarter]) / COUNT(opps.cycle_days[segment=@segment, won=1, close_quarter=@quarter]), BLANK)']},
    'company_quarterly': {'name': 'Company quarterly', 'dims': {'quarter': 'quarters', 'period': False},
      'lines': [L('quota', 'Quota'), L('bookings', 'Bookings'), L('attainment', 'Attainment', PCT), L('forecast', 'Forecast (booked + weighted pipeline)'), L('forecast_attainment', 'Forecast attainment', PCT), L('gap', 'Gap to quota'), L('open_pipeline', 'Open pipeline'), L('commit', 'Commit'), L('best_case', 'Best case'), L('coverage', 'Coverage of gap (x)'), L('pipeline_created', 'Pipeline created'), L('deals_won', 'Deals won'), L('deals_lost', 'Deals lost'), L('win_rate', 'Win rate', PCT), L('avg_deal', 'Average deal'), L('avg_cycle_days', 'Average sales cycle (days)'), L('new_logo_bookings', 'New-logo bookings'), L('new_logo_share', 'New-logo share of bookings', PCT), L('expansion_bookings', 'Expansion bookings'), L('variable_pay', 'Sales variable pay'), L('pay_rate', 'Variable pay as % of bookings', PCT), L('marketing_spend', 'Marketing spend'), L('marketing_ratio', 'Marketing spend as % of bookings', PCT), L('leads', 'Leads'), L('mqls', 'MQLs'), L('opps_created', 'Opportunities created')],
      'rules': [f'{l} = SUM(team.{l})' for l in ('quota', 'bookings', 'forecast', 'open_pipeline', 'commit', 'best_case', 'pipeline_created', 'deals_won', 'deals_lost', 'new_logo_bookings', 'variable_pay')] +
               ['attainment = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / quota, 0))', 'forecast_attainment = IFERROR(forecast / quota, 0)', 'gap = quota - bookings', 'coverage = IF(gap > 0 and open_pipeline > 0, open_pipeline / gap, BLANK)',
                'win_rate = IF(quarter.is_future = 1, BLANK, IFERROR(deals_won / (deals_won + deals_lost), 0))', 'avg_deal = IF(quarter.is_future = 1, BLANK, IFERROR(bookings / deals_won, 0))', 'avg_cycle_days = IFERROR(SUM(opps.cycle_days[won=1, close_quarter=@quarter]) / COUNT(opps.cycle_days[won=1, close_quarter=@quarter]), BLANK)',
                'new_logo_share = IFERROR(new_logo_bookings / bookings, 0)', 'expansion_bookings = bookings - new_logo_bookings', 'pay_rate = IFERROR(variable_pay / bookings, 0)',
                'marketing_spend = SUM(funnel.spend[period.quarter=@quarter.label])', 'marketing_ratio = IFERROR(marketing_spend / bookings, 0)',
                'leads = SUM(funnel.leads[period.quarter=@quarter.label])', 'mqls = SUM(funnel.mqls[period.quarter=@quarter.label])', 'opps_created = SUM(funnel.opps_created[period.quarter=@quarter.label])']},
    'company_monthly': {'name': 'Company monthly and ARR bridge', 'dims': {},
      'lines': [L('bookings', 'Bookings'), L('quota', 'Quota (quarter ÷ 3)'), L('attainment', 'Attainment', PCT), L('new_logo_bookings', 'New-logo bookings'), L('expansion_bookings', 'Expansion bookings'), L('open_pipeline', 'Open pipeline closing this month'), L('forecast', 'Forecast'), L('pipeline_created', 'Pipeline created'), L('opps_created', 'Opportunities created'), L('deals_won', 'Deals won'),
                L('beginning_arr', 'Beginning ARR'), L('new_arr', 'New-logo ARR'), L('expansion_arr', 'Expansion ARR'), L('churned_arr', 'Churned ARR'), L('ending_arr', 'Ending ARR'), L('net_new_arr', 'Net new ARR'), L('arr_growth', 'ARR growth (month)', PCT), L('churn_rate', 'Monthly gross churn', PCT)],
      'rules': ['bookings = SUM(rep_monthly.bookings)', 'quota = SUM(company_quarterly.quota[quarter.label=@period.quarter]) / 3', 'attainment = IF(period.frame = "fcst", BLANK, IFERROR(bookings / quota, 0))',
                'new_logo_bookings = SUM(rep_monthly.new_logo_bookings)', 'expansion_bookings = SUM(rep_monthly.expansion_bookings)', 'open_pipeline = SUM(rep_monthly.open_pipeline)', 'forecast = SUM(rep_monthly.forecast)',
                'pipeline_created = SUM(rep_monthly.pipeline_created)', 'opps_created = SUM(rep_monthly.opps_created)', 'deals_won = SUM(rep_monthly.deals_won)',
                'beginning_arr = IF(period.idx = 0, plan.starting_arr, PREV(ending_arr))', 'new_arr = new_logo_bookings', 'expansion_arr = expansion_bookings', 'churned_arr = -SUM(churn.arr_lost)',
                'ending_arr = beginning_arr + new_arr + expansion_arr + churned_arr', 'net_new_arr = ending_arr - beginning_arr', 'arr_growth = IFERROR(net_new_arr / beginning_arr, 0)', 'churn_rate = IFERROR(-churned_arr / beginning_arr, 0)']},
  },
  'outputs': [
    {'pivot': 'company_quarterly', 'rows': ['line'], 'cols': ['quarter'], 'title': 'Company by quarter', 'decimals': 0},
    {'pivot': 'company_monthly', 'rows': ['line'], 'cols': ['period'], 'title': 'Company by month', 'decimals': 0},
    {'pivot': 'region_quarterly', 'rows': ['region'], 'cols': ['line'], 'pages': {'quarter': 'q3_2026'}, 'lines': ['quota', 'bookings', 'attainment', 'forecast', 'coverage', 'win_rate'], 'title': 'Regions, Q3 2026'},
    {'pivot': 'payout', 'rows': ['rep'], 'cols': ['line'], 'pages': {'quarter': 'q2_2026'}, 'lines': ['bookings', 'attainment', 'base_commission', 'new_logo_kicker', 'multiyear_kicker', 'total_variable', 'vs_target'], 'title': 'Variable pay, Q2 2026'},
  ],
}

# ---------------------------------------------------------------- dashboards
Q = 'q3_2026'; PREVQ = 'q2_2026'; M = 'aug26'
STAR = sorted([r for r in reps if r['start'] < '2025-04-01'], key=lambda r: -by_rep[r['id']] / max(1, sum(v['value'] for v in quota_plan if v['at']['rep'] == r['id'] and v['at']['quarter'] in ('q1_2026', 'q2_2026', 'q3_2026'))))[2]['id']
def kpi(pivot, line, title, **kw): return dict(kind='kpi', pivot=pivot, line=line, title=title, **kw)
NAV = dict(kind='links')   # a row of links to the other dashboards, first on every page
def table(pivot, title, **kw): return dict(kind='table', pivot=pivot, title=title, **kw)
def chart(pivot, title, **kw): return dict(kind='chart', pivot=pivot, title=title, **kw)
QF = {'quarter': [PREVQ, Q]}   # a KPI shows the last column and its change from the one before
Y26 = {'quarter': ['q1_2026', 'q2_2026', 'q3_2026', 'q4_2026']}
QT = {'quarter': ['q4_2025', 'q1_2026', 'q2_2026', 'q3_2026', 'q4_2026']}   # tables: last closed year-end quarter onward
MONTHS26 = [pid(2026, m) for m in range(1, 13)]

doc['dashboards'] = [
  {'id': 'cro', 'name': 'CRO: revenue overview', 'theme': 'revenue', 'cards': [
    NAV,
    kpi('company_quarterly', 'bookings', 'Bookings, Q3 to date', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'attainment', 'Attainment, Q3 to date', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'forecast_attainment', 'Forecast attainment, Q3', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'coverage', 'Pipeline coverage of Q3 gap', filters=QF, cols=['quarter']),
    chart('company_quarterly', 'Bookings, forecast and quota by quarter', type='bar', rows=['line'], cols=['quarter'], lines=['bookings', 'forecast', 'quota'], filters=Y26, w=6),
    chart('company_quarterly', 'Attainment and forecast attainment', type='line', rows=['line'], cols=['quarter'], lines=['attainment', 'forecast_attainment'], filters=Y26, w=6),
    chart('company_monthly', 'ARR bridge by month', type='stackedBar', rows=['line'], cols=['period'], lines=['new_arr', 'expansion_arr', 'churned_arr'], periods=MONTHS26[:8], w=6),
    chart('company_monthly', 'Ending ARR', type='bar', rows=['line'], cols=['period'], lines=['ending_arr'], periods=MONTHS26[:8], w=6),
    chart('region_quarterly', 'Bookings by region', type='bar', rows=['region'], cols=['quarter'], pages={'line': 'bookings'}, filters=Y26, w=6),
    chart('segment_quarterly', 'Win rate by segment', type='line', rows=['segment'], cols=['quarter'], pages={'line': 'win_rate'}, filters=Y26, w=6),
    table('company_quarterly', 'Company scorecard by quarter', rows=['line'], cols=['quarter'], filters=QT, lines=['quota', 'bookings', 'attainment', 'forecast', 'forecast_attainment', 'open_pipeline', 'coverage', 'deals_won', 'win_rate', 'avg_deal', 'avg_cycle_days', 'new_logo_share', 'variable_pay', 'pay_rate', 'marketing_spend', 'marketing_ratio']),
  ]},
  {'id': 'vp', 'name': 'VP Sales: teams and forecast', 'theme': 'revenue', 'cards': [
    NAV,
    kpi('company_quarterly', 'forecast', 'Q3 forecast', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'gap', 'Q3 gap to quota', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'win_rate', 'Win rate, Q3', filters=QF, cols=['quarter']),
    kpi('company_quarterly', 'avg_deal', 'Average deal, Q3', filters=QF, cols=['quarter']),
    table('team', 'Teams, Q3 2026', rows=['region', 'segment'], cols=['line'], pages={'quarter': Q}, lines=['rep_count', 'quota', 'bookings', 'attainment', 'forecast', 'forecast_attainment', 'open_pipeline', 'coverage', 'win_rate', 'avg_deal']),
    chart('region_quarterly', 'Forecast attainment by region', type='line', rows=['region'], cols=['quarter'], pages={'line': 'forecast_attainment'}, filters=Y26, w=6),
    chart('company_quarterly', 'Q3 forecast build: booked, commit, best case', type='bar', rows=['line'], cols=['quarter'], lines=['bookings', 'commit', 'best_case'], filters=Y26, w=6),
    table('rep_quarterly', 'Rep leaderboard, Q3 2026', rows=['rep'], cols=['line'], pages={'quarter': Q}, lines=['quota', 'bookings', 'attainment', 'forecast', 'forecast_attainment', 'open_pipeline', 'coverage', 'deals_won', 'win_rate', 'avg_deal', 'ytd_attainment']),
    chart('segment_quarterly', 'Average deal by segment', type='bar', rows=['segment'], cols=['quarter'], pages={'line': 'avg_deal'}, filters=Y26, w=6),
    chart('segment_quarterly', 'Sales cycle by segment (days)', type='bar', rows=['segment'], cols=['quarter'], pages={'line': 'avg_cycle_days'}, filters=Y26, w=6),
  ]},
  {'id': 'ops', 'name': 'Sales ops: plan, quotas and commissions', 'theme': 'revenue', 'cards': [
    NAV,
    table('comp_plan', 'Commission plan: attainment bands and multipliers (edit)', rows=['tranche'], cols=['line'], editable=True, filters={'tranche': ['t1', 't2', 't3', 't4', 't5']}, w=6),
    table('plan', 'Kickers, SPIFF and forecast weights (edit)', rows=['line'], editable=True, w=6),
    table('quota_plan', 'Quota plan by rep and quarter (edit)', rows=['rep'], cols=['quarter'], filters=QT, editable=True),
    table('payout', 'Variable pay, Q3 2026', rows=['rep'], cols=['line'], pages={'quarter': Q}, lines=['quota', 'bookings', 'attainment', 'base_commission', 'new_logo_kicker', 'multiyear_kicker', 'spiff', 'total_variable', 'vs_target', 'effective_rate', 'ytd_attainment', 'club']),
    chart('company_quarterly', 'Sales variable pay by quarter', type='bar', rows=['line'], cols=['quarter'], lines=['variable_pay'], filters=Y26, w=6),
    chart('company_quarterly', 'Variable pay as % of bookings', type='line', rows=['line'], cols=['quarter'], lines=['pay_rate'], filters=Y26, w=6),
    table('rep_quarterly', 'Pipeline coverage by rep, Q3 2026', rows=['rep'], cols=['line'], pages={'quarter': Q}, lines=['gap', 'open_pipeline', 'commit', 'best_case', 'coverage', 'pipeline_created', 'opps_created']),
    table('team', 'Variable pay by team, Q2 2026 (paid)', rows=['region', 'segment'], cols=['line'], pages={'quarter': PREVQ}, lines=['rep_count', 'bookings', 'attainment', 'variable_pay', 'pay_rate']),
  ]},
  {'id': 'rep', 'name': f'Rep scorecard: {next(r["name"] for r in reps if r["id"] == STAR)}', 'theme': 'revenue', 'cards': [
    NAV,
    kpi('rep_quarterly', 'bookings', 'Q3 bookings', pages={'rep': STAR}, filters=QF, cols=['quarter']),
    kpi('rep_quarterly', 'attainment', 'Q3 attainment', pages={'rep': STAR}, filters=QF, cols=['quarter']),
    kpi('rep_quarterly', 'coverage', 'Coverage of Q3 gap', pages={'rep': STAR}, filters=QF, cols=['quarter']),
    kpi('payout', 'total_variable', 'Q3 variable pay to date', pages={'rep': STAR}, filters=QF, cols=['quarter']),
    chart('rep_monthly', 'Bookings and pipeline by month', type='bar', rows=['line'], cols=['period'], lines=['bookings', 'open_pipeline'], pages={'rep': STAR}, periods=MONTHS26, w=6),
    chart('rep_quarterly', 'Attainment by quarter', type='line', rows=['line'], cols=['quarter'], lines=['attainment', 'forecast_attainment', 'ytd_attainment'], pages={'rep': STAR}, filters=Y26, w=6),
    table('rep_quarterly', 'Quarterly scorecard', rows=['line'], cols=['quarter'], pages={'rep': STAR}, filters=QT, lines=['quota', 'bookings', 'attainment', 'gap', 'deals_won', 'deals_lost', 'win_rate', 'avg_deal', 'new_logos', 'open_pipeline', 'commit', 'best_case', 'coverage', 'forecast', 'forecast_attainment']),
    table('commissions', 'Commission statement, Q3 2026 (by tranche)', rows=['tranche'], cols=['line'], pages={'rep': STAR, 'quarter': Q}, w=6),
    table('payout', 'Variable pay by quarter', rows=['line'], cols=['quarter'], pages={'rep': STAR}, filters=QT, lines=['base_commission', 'new_logo_kicker', 'multiyear_kicker', 'spiff', 'uncapped_variable', 'target_variable', 'total_variable', 'vs_target', 'ytd_variable', 'club'], w=6),
  ]},
  {'id': 'sdr', 'name': 'SDR and BDR: pipeline generation', 'theme': 'revenue', 'cards': [
    NAV,
    table('sdr_scorecard', 'Scorecard, August 2026', rows=['sdr'], cols=['line'], pages={'period': M}, lines=['calls', 'connects', 'meetings_set', 'meetings_held', 'sqls', 'sql_quota', 'attainment', 'connect_rate', 'show_rate', 'opps_sourced', 'pipeline_sourced', 'pipeline_per_sql']),
    chart('sdr_scorecard', 'SQLs by month', type='bar', rows=['sdr'], cols=['period'], pages={'line': 'sqls'}, periods=MONTHS26[:8], w=6),
    chart('sdr_scorecard', 'SQL attainment by month', type='line', rows=['sdr'], cols=['period'], pages={'line': 'attainment'}, periods=MONTHS26[:8], w=6),
    chart('sdr_scorecard', 'Pipeline sourced by month', type='bar', rows=['sdr'], cols=['period'], pages={'line': 'pipeline_sourced'}, periods=MONTHS26[:8], w=6),
    chart('sdr_scorecard', 'Connect rate by month', type='line', rows=['sdr'], cols=['period'], pages={'line': 'connect_rate'}, periods=MONTHS26[:8], w=6),
    table('sdr_scorecard', 'Sourced bookings by month (deals closed)', rows=['sdr'], cols=['period'], pages={'line': 'won_sourced'}, periods=MONTHS26[:8]),
  ]},
  {'id': 'marketing', 'name': 'Marketing: funnel and pipeline', 'theme': 'revenue', 'cards': [
    NAV,
    table('channel_summary', 'Funnel by channel, August 2026', rows=['channel'], cols=['line'], pages={'period': M}, lines=['spend', 'leads', 'mqls', 'opps_created', 'pipeline_created', 'deals_won', 'won_acv', 'cost_per_lead', 'mql_rate', 'sql_rate', 'cost_per_opp', 'pipeline_per_dollar']),
    chart('channel_summary', 'Spend by channel', type='stackedBar', rows=['channel'], cols=['period'], pages={'line': 'spend'}, periods=MONTHS26[:8], filters={'channel': ['inbound', 'paid', 'events', 'partner']}, w=6),
    chart('channel_summary', 'Pipeline created by channel', type='stackedBar', rows=['channel'], cols=['period'], pages={'line': 'pipeline_created'}, periods=MONTHS26[:8], w=6),
    chart('channel_summary', 'Lead to MQL by channel', type='line', rows=['channel'], cols=['period'], pages={'line': 'mql_rate'}, periods=MONTHS26[:8], filters={'channel': ['inbound', 'paid', 'events', 'partner']}, w=6),
    chart('channel_summary', 'Cost per opportunity by channel', type='bar', rows=['channel'], cols=['period'], pages={'line': 'cost_per_opp'}, periods=MONTHS26[:8], filters={'channel': ['inbound', 'paid', 'events', 'partner']}, w=6),
    table('funnel', 'Inbound funnel by region, August 2026', rows=['region'], cols=['line'], pages={'channel': 'inbound', 'period': M}, lines=['spend', 'leads', 'mqls', 'opps_created', 'pipeline_created', 'cost_per_lead', 'mql_rate', 'sql_rate', 'cost_per_opp']),
    chart('company_monthly', 'Opportunities created by month', type='bar', rows=['line'], cols=['period'], lines=['opps_created'], periods=MONTHS26[:9], w=6),
    chart('company_monthly', 'Pipeline created by month', type='bar', rows=['line'], cols=['period'], lines=['pipeline_created'], periods=MONTHS26[:9], w=6),
  ]},
]

# ---------------------------------------------------------------- write (pretty structure, compact rows)
def dump(o, ind=0):
    pad = '  ' * ind
    if isinstance(o, dict):
        if not o: return '{}'
        return '{\n' + ',\n'.join(f'{pad}  {json.dumps(k)}: {dump(v, ind + 1)}' for k, v in o.items()) + f'\n{pad}}}'
    if isinstance(o, list):
        if not o: return '[]'
        if all(isinstance(x, dict) and all(not isinstance(v, (dict, list)) or k == 'at' for k, v in x.items()) for x in o):
            return '[\n' + ',\n'.join(f'{pad}  {json.dumps(x, ensure_ascii=False)}' for x in o) + f'\n{pad}]'
        if all(isinstance(x, (str, int, float)) for x in o) and len(json.dumps(o)) < 100: return json.dumps(o, ensure_ascii=False)
        return '[\n' + ',\n'.join(f'{pad}  {dump(x, ind + 1)}' for x in o) + f'\n{pad}]'
    return json.dumps(o, ensure_ascii=False)

import os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'salesops.json')
with open(out, 'w') as fh: fh.write(dump(doc) + '\n')
print('wrote', os.path.normpath(out), f'{os.path.getsize(out)/1024:.0f} KB; star rep {STAR}')
