/**
 * Presets: a few parameters become the requests of a source. FMP (Financial Modeling Prep) is the first;
 * a preset is a table of URL templates and curated field maps, so a new provider is data, not engine code.
 */
import type { FieldMap, SourceRequest, TableSource } from './types.js';
import { SourceError } from './types.js';

export interface PresetParam { id: string; label: string; hint?: string; default?: string; options?: { id: string; label: string }[]; required?: boolean }
export interface Preset {
  id: string; name: string; secret: string; docs: string;
  params: PresetParam[];
  expand(params: Record<string, string>): SourceRequest[];
}

const FMP = 'https://financialmodelingprep.com/stable';
const KEY = '{{secret:fmp}}';
const symbolsOf = (p: Record<string, string>) => (p.symbols ?? p.symbol ?? '').split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const unscaled = (from: string): FieldMap => ({ from, scale: false });
const year = (from: string): FieldMap => ({ from, transform: 'year' });

/** Per-period keys shared by the three statements. */
const PERIOD_KEYS: Record<string, FieldMap> = { fiscal_year: unscaled('fiscalYear'), period: 'period', date: 'date', currency: 'reportedCurrency' };
const INCOME: Record<string, FieldMap> = {
  ...PERIOD_KEYS,
  revenue: 'revenue', cogs: 'costOfRevenue', gross_profit: 'grossProfit', rd: 'researchAndDevelopmentExpenses', sga: 'sellingGeneralAndAdministrativeExpenses',
  opex: 'operatingExpenses', operating_income: 'operatingIncome', da: 'depreciationAndAmortization', ebitda: 'ebitda', ebit: 'ebit',
  interest_expense: 'interestExpense', interest_income: 'interestIncome', pretax_income: 'incomeBeforeTax', tax: 'incomeTaxExpense', net_income: 'netIncome',
  eps: unscaled('eps'), eps_diluted: unscaled('epsDiluted'), shares: 'weightedAverageShsOut', shares_diluted: 'weightedAverageShsOutDil',
};
const BALANCE: Record<string, FieldMap> = {
  ...PERIOD_KEYS,
  cash: 'cashAndCashEquivalents', cash_and_investments: 'cashAndShortTermInvestments', receivables: 'netReceivables', inventory: 'inventory',
  total_current_assets: 'totalCurrentAssets', ppe: 'propertyPlantEquipmentNet', goodwill_and_intangibles: 'goodwillAndIntangibleAssets', total_assets: 'totalAssets',
  payables: 'accountPayables', short_term_debt: 'shortTermDebt', long_term_debt: 'longTermDebt', total_debt: 'totalDebt', net_debt: 'netDebt',
  total_current_liabilities: 'totalCurrentLiabilities', total_liabilities: 'totalLiabilities', equity: 'totalStockholdersEquity',
};
const CASHFLOW: Record<string, FieldMap> = {
  ...PERIOD_KEYS,
  cfo: 'operatingCashFlow', capex: 'capitalExpenditure', fcf: 'freeCashFlow', sbc: 'stockBasedCompensation', acquisitions: 'acquisitionsNet',
  buybacks: 'commonStockRepurchased', dividends: 'netDividendsPaid', debt_issued: 'netDebtIssuance', cfi: 'netCashProvidedByInvestingActivities',
  cff: 'netCashProvidedByFinancingActivities', net_change_in_cash: 'netChangeInCash',
};
const PROFILE: Record<string, FieldMap> = {
  name: 'companyName', price: unscaled('price'), market_cap: 'marketCap', beta: unscaled('beta'), currency: 'currency', exchange: 'exchange',
  sector: 'sector', industry: 'industry', last_dividend: unscaled('lastDividend'), cik: 'cik',
};
const QUOTE: Record<string, FieldMap> = {
  name: 'name', price: unscaled('price'), market_cap: 'marketCap', change_pct: unscaled('changePercentage'), day_low: unscaled('dayLow'), day_high: unscaled('dayHigh'),
  year_low: unscaled('yearLow'), year_high: unscaled('yearHigh'), price_avg_50: unscaled('priceAvg50'), price_avg_200: unscaled('priceAvg200'), previous_close: unscaled('previousClose'),
};
const ESTIMATES: Record<string, FieldMap> = {
  date: 'date', fiscal_year: year('date'), revenue: 'revenueAvg', revenue_low: 'revenueLow', revenue_high: 'revenueHigh', ebitda: 'ebitdaAvg', ebit: 'ebitAvg',
  net_income: 'netIncomeAvg', eps: unscaled('epsAvg'), eps_low: unscaled('epsLow'), eps_high: unscaled('epsHigh'), analysts_revenue: unscaled('numAnalystsRevenue'), analysts_eps: unscaled('numAnalystsEps'),
};
const METRICS: Record<string, FieldMap> = {
  ...PERIOD_KEYS, market_cap: 'marketCap', ev: 'enterpriseValue', ev_to_sales: unscaled('evToSales'), ev_to_ebitda: unscaled('evToEBITDA'), ev_to_fcf: unscaled('evToFreeCashFlow'),
  net_debt_to_ebitda: unscaled('netDebtToEBITDA'), roe: unscaled('returnOnEquity'), roic: unscaled('returnOnInvestedCapital'), roa: unscaled('returnOnAssets'),
  fcf_yield: unscaled('freeCashFlowYield'), earnings_yield: unscaled('earningsYield'), current_ratio: unscaled('currentRatio'), working_capital: 'workingCapital', invested_capital: 'investedCapital',
};
const RATIOS: Record<string, FieldMap> = {
  ...PERIOD_KEYS, gross_margin: unscaled('grossProfitMargin'), ebitda_margin: unscaled('ebitdaMargin'), ebit_margin: unscaled('ebitMargin'), operating_margin: unscaled('operatingProfitMargin'),
  net_margin: unscaled('netProfitMargin'), pe: unscaled('priceToEarningsRatio'), pe_diluted: unscaled('priceToEarningsDilutedRatio'), peg: unscaled('priceToEarningsGrowthRatio'),
  ps: unscaled('priceToSalesRatio'), pb: unscaled('priceToBookRatio'), p_fcf: unscaled('priceToFreeCashFlowRatio'), debt_to_equity: unscaled('debtToEquityRatio'),
  debt_to_assets: unscaled('debtToAssetsRatio'), current_ratio: unscaled('currentRatio'), quick_ratio: unscaled('quickRatio'), asset_turnover: unscaled('assetTurnover'),
};

/** One comps-ready row per ticker: market data, LTM from the last four quarters, the prior four for growth, NTM from consensus. */
const COMPS_REQUESTS = (symbol: string, scale: number, constants: Record<string, string | number>): SourceRequest[] => {
  const q = (path: string, params: Record<string, string>) => `${FMP}/${path}?${new URLSearchParams({ symbol, ...params })}&apikey=${KEY}`;
  const base = { format: 'json' as const, id: symbol, constants, scale };
  return [
    { ...base, url: q('quote', {}), map: { name: 'name', price: unscaled('price'), market_cap: 'marketCap', year_low: unscaled('yearLow'), year_high: unscaled('yearHigh') } },
    { ...base, url: q('shares-float', {}), map: { shares: 'outstandingShares' } },
    { ...base, url: q('income-statement', { period: 'quarter', limit: '8' }), reduce: { by: 'date', desc: true, take: 4, sum: ['revenue', 'ebitda', 'operatingIncome', 'netIncome', 'epsDiluted'] },
      map: { ltm_through: 'date', currency: 'reportedCurrency', revenue_ltm: 'revenue', ebitda_ltm: 'ebitda', ebit_ltm: 'operatingIncome', net_income_ltm: 'netIncome', eps_ltm: unscaled('epsDiluted'), shares_diluted: 'weightedAverageShsOutDil', quarters_ltm: unscaled('_records') } },
    { ...base, url: q('income-statement', { period: 'quarter', limit: '8' }), reduce: { by: 'date', desc: true, skip: 4, take: 4, sum: ['revenue', 'ebitda', 'epsDiluted'] },
      map: { revenue_prior: 'revenue', ebitda_prior: 'ebitda', eps_prior: unscaled('epsDiluted') } },
    { ...base, url: q('balance-sheet-statement', { period: 'quarter', limit: '1' }), reduce: { by: 'date', desc: true, take: 1 }, map: { balance_date: 'date', cash: 'cashAndShortTermInvestments', debt: 'totalDebt', net_debt: 'netDebt', equity: 'totalStockholdersEquity' } },
    { ...base, url: q('analyst-estimates', { period: 'annual', limit: '6' }), reduce: { by: 'date', desc: false, after: 'today', take: 1 },
      map: { ntm_fy_end: 'date', revenue_ntm: 'revenueAvg', ebitda_ntm: 'ebitdaAvg', ebit_ntm: 'ebitAvg', net_income_ntm: 'netIncomeAvg', eps_ntm: unscaled('epsAvg'), analysts: unscaled('numAnalystsRevenue') } },
  ];
};

type Dataset = { endpoints: { path: string; map: Record<string, FieldMap>; perPeriod: boolean; periodParam?: boolean }[] };
const DATASETS: Record<string, Dataset> = {
  financials: { endpoints: [{ path: 'income-statement', map: INCOME, perPeriod: true, periodParam: true }, { path: 'balance-sheet-statement', map: BALANCE, perPeriod: true, periodParam: true }, { path: 'cash-flow-statement', map: CASHFLOW, perPeriod: true, periodParam: true }] },
  income: { endpoints: [{ path: 'income-statement', map: INCOME, perPeriod: true, periodParam: true }] },
  balance: { endpoints: [{ path: 'balance-sheet-statement', map: BALANCE, perPeriod: true, periodParam: true }] },
  cashflow: { endpoints: [{ path: 'cash-flow-statement', map: CASHFLOW, perPeriod: true, periodParam: true }] },
  metrics: { endpoints: [{ path: 'key-metrics', map: METRICS, perPeriod: true, periodParam: true }] },
  ratios: { endpoints: [{ path: 'ratios', map: RATIOS, perPeriod: true, periodParam: true }] },
  estimates: { endpoints: [{ path: 'analyst-estimates', map: ESTIMATES, perPeriod: true, periodParam: true }] },
  profile: { endpoints: [{ path: 'profile', map: PROFILE, perPeriod: false }] },
  quote: { endpoints: [{ path: 'quote', map: QUOTE, perPeriod: false }] },
};

const fmp: Preset = {
  id: 'fmp', name: 'Financial Modeling Prep', secret: 'fmp', docs: 'https://site.financialmodelingprep.com/developer/docs',
  params: [
    { id: 'symbols', label: 'Tickers', hint: 'One or more, comma-separated: NVDA, AMD, AVGO', required: true },
    { id: 'dataset', label: 'Dataset', default: 'financials', options: [
      { id: 'comps', label: 'Comps: one row per ticker with price, LTM, NTM, cash and debt' },
      { id: 'financials', label: 'Financial statements (income, balance sheet, cash flow)' }, { id: 'income', label: 'Income statement' }, { id: 'balance', label: 'Balance sheet' }, { id: 'cashflow', label: 'Cash flow statement' },
      { id: 'metrics', label: 'Key metrics (EV, multiples, returns)' }, { id: 'ratios', label: 'Ratios and margins' }, { id: 'estimates', label: 'Analyst estimates' }, { id: 'profile', label: 'Company profile (price, market cap, beta)' }, { id: 'quote', label: 'Quote' } ] },
    { id: 'period', label: 'Period', default: 'annual', options: [{ id: 'annual', label: 'Annual' }, { id: 'quarter', label: 'Quarterly' }] },
    { id: 'limit', label: 'Periods', default: '10', hint: 'How many most-recent periods' },
    { id: 'subject', label: 'Subject', hint: 'Comps only: the ticker being valued; it gets peer = 0, the others peer = 1' },
    { id: 'scale', label: 'Units', default: '1000000', options: [{ id: '1', label: 'As reported' }, { id: '1000', label: 'Thousands' }, { id: '1000000', label: 'Millions' }, { id: '1000000000', label: 'Billions' }] },
  ],
  expand(p) {
    const symbols = symbolsOf(p);
    if (!symbols.length) throw new SourceError('SOURCE_BAD_PRESET', 'fmp needs at least one ticker in symbols', 'e.g. { "symbols": "NVDA" }');
    const period = p.period === 'quarter' ? 'quarter' : 'annual';
    const limit = num(p.limit, period === 'quarter' ? 12 : 10);
    const scale = num(p.scale, 1e6);
    const subject = (p.subject ?? '').trim().toUpperCase();
    if ((p.dataset ?? 'financials') === 'comps') return symbols.flatMap(symbol => COMPS_REQUESTS(symbol, scale, { symbol, peer: subject ? (symbol === subject ? 0 : 1) : 1 }));
    const ds = DATASETS[p.dataset ?? 'financials'];
    if (!ds) throw new SourceError('SOURCE_BAD_PRESET', `unknown fmp dataset ${p.dataset}`, `comps, ${Object.keys(DATASETS).join(', ')}`);
    const out: SourceRequest[] = [];
    for (const symbol of symbols) for (const e of ds.endpoints) {
      const q = new URLSearchParams({ symbol });
      if (e.periodParam) { q.set('period', period); q.set('limit', String(limit)); }
      out.push({
        url: `${FMP}/${e.path}?${q}&apikey=${KEY}`, format: 'json', map: e.map, scale,
        constants: subject ? { symbol, peer: symbol === subject ? 0 : 1 } : { symbol },
        id: e.perPeriod ? (e.path === 'analyst-estimates' ? `${symbol}_{date:year}` : period === 'quarter' ? `${symbol}_{fiscalYear}{period}` : `${symbol}_{fiscalYear}`) : symbol,
      });
    }
    return out;
  },
};

export const PRESETS: Record<string, Preset> = { fmp };

/** The requests a source stands for: its preset expanded, else its explicit requests, else the source itself as one request. */
export function requestsOf(source: TableSource): SourceRequest[] {
  if (source.preset) {
    const preset = PRESETS[source.preset.id];
    if (!preset) throw new SourceError('SOURCE_UNKNOWN_PRESET', `unknown preset ${source.preset.id}`, `one of ${Object.keys(PRESETS).join(', ')}`);
    return preset.expand(source.preset.params ?? {});
  }
  if (source.requests?.length) return source.requests;
  if (source.url) { const { preset: _p, requests: _r, mode: _m, fetchedAt: _f, status: _s, error: _e, fetchedRows: _n, ...req } = source; return [req as SourceRequest]; }
  throw new SourceError('SOURCE_EMPTY', 'a source needs a preset, requests, or a url');
}

/** The presets as the UI needs them (no functions). */
export function describePresets() {
  return Object.values(PRESETS).map(p => ({ id: p.id, name: p.name, secret: p.secret, docs: p.docs, params: p.params }));
}
