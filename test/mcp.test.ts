/** End-to-end test of the MCP server through the SDK's in-memory transport (doc 08 §2, S1). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FiniDB } from '../src/index.js';
import { createMcpServer } from '../src/mcp/server.js';

const TOOLS = ['finicast_schema', 'finicast_create_model', 'finicast_load_table', 'finicast_define_pivot', 'finicast_set_rules', 'finicast_set_values', 'finicast_query', 'finicast_explain', 'finicast_share'];

async function connect() {
  const f = new FiniDB();
  const server = createMcpServer(f);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0].text;
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { isError: !!r.isError, text, json };
  };
  return { f, client, call, close: () => client.close() };
}

/** S1: the NVDA income statement built only through the tools. */
async function buildNvda(call: Awaited<ReturnType<typeof connect>>['call']) {
  let r = await call('finicast_create_model', { model: 'nvda', description: 'NVDA forecast' });
  assert.equal(r.json.ok, true);
  r = await call('finicast_load_table', { model: 'nvda', table: 'drivers', source: { inline: [{ id: 'revenue_growth' }, { id: 'cogs_pct' }, { id: 'opex_growth' }, { id: 'tax_rate' }] } });
  assert.equal(r.json.rows, 4);
  // generated periods come from define_pivot
  r = await call('finicast_define_pivot', { model: 'nvda', table: 'assumptions', dims: [{ id: 'driver', from: 'drivers' }, { id: 'period', from: { periods: { start: '2024-01', count: 6, grain: 'year', histUntil: '2026-12-31' } } }], lineDim: 'driver' });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.timeDim, 'period');
  assert.match(r.json.created[0], /periods \(6 years from fy2024 to fy2029/);
  // the fact table: period is detected as a reference to periods
  const fin: Record<string, unknown>[] = [];
  const data: Record<string, [number, number, number]> = { revenue: [60922, 130497, 180000], cogs: [16621, 32639, 45000], rnd: [8675, 12914, 16000], sga: [2654, 3491, 4000] };
  for (const [account, vals] of Object.entries(data)) vals.forEach((amount, i) => fin.push({ account, period: `fy${2024 + i}`, amount }));
  fin.push({ account: 'revenue', period: 'fy2025', amount: 3 });
  r = await call('finicast_load_table', { model: 'nvda', table: 'financials', source: { inline: fin } });
  assert.equal(r.json.rows, 13);
  const periodField = r.json.fields.find((x: any) => x.id === 'period');
  assert.equal(periodField.refCandidate, 'periods');
  assert.equal(r.json.fields.find((x: any) => x.id === 'amount').type, 'number');
  r = await call('finicast_load_table', { model: 'nvda', table: 'is_lines', source: { csv: 'id,name,category\nrevenue,Revenue,flow\ncogs,COGS,flow\ngross_profit,Gross Profit,flow\nrnd,R&D,opex\nsga,SG&A,opex\nopex,Opex,flow\nebit,EBIT,flow\ntax,Tax,flow\nnet_income,Net Income,flow\ngross_margin,Gross Margin,ratio\ncum_ni,Cumulative NI,flow\n' } });
  assert.equal(r.json.rows, 11);
  assert.equal(r.json.idColumn, 'id');
  r = await call('finicast_define_pivot', { model: 'nvda', table: 'income_statement', dims: [{ id: 'line', from: 'is_lines' }, { id: 'period', from: 'periods' }], lineDim: 'line', timeDim: 'period' });
  assert.equal(r.json.ok, true, r.text);
  const values: unknown[] = [];
  for (const period of ['fy2027', 'fy2028', 'fy2029']) for (const [driver, value] of [['revenue_growth', 0.4], ['cogs_pct', 0.25], ['opex_growth', 0.1], ['tax_rate', 0.15]] as const) values.push({ at: { driver, period }, value });
  r = await call('finicast_set_values', { model: 'nvda', table: 'assumptions', values });
  assert.equal(r.json.set, 12);
  r = await call('finicast_set_rules', { model: 'nvda', table: 'income_statement', rules: `
    revenue[frame=hist]      = SUM(financials.amount[account=revenue])
    cogs[frame=hist]         = SUM(financials.amount[account=cogs])
    rnd[frame=hist]          = SUM(financials.amount[account=rnd])
    sga[frame=hist]          = SUM(financials.amount[account=sga])
    revenue[frame=fcst]      = PREV(revenue) * (1 + assumptions.revenue_growth)
    cogs[frame=fcst]         = revenue * assumptions.cogs_pct
    rnd[frame=fcst]          = PREV(rnd) * (1 + assumptions.opex_growth)
    sga[frame=fcst]          = PREV(sga) * (1 + assumptions.opex_growth)
    gross_profit             = revenue - cogs
    opex                     = SUM(value[line.category = opex])
    ebit                     = gross_profit - opex
    tax                      = IF(ebit > 0, ebit * assumptions.tax_rate, 0)
    net_income               = ebit - tax
    gross_margin             = gross_profit / revenue
    cum_ni                   = CUMSUM(net_income)
  ` });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.compiled.length, 15);
  assert.equal(r.json.compiled[0], 'value[line=revenue, frame=hist] = SUM(financials.amount[account=revenue])');
}

test('nine tools and the help prompt are registered', async () => {
  const { client, close } = await connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), [...TOOLS].sort());
  for (const t of tools.tools) assert.ok((t.description ?? '').length > 40, `${t.name} needs a description with decision criteria`);
  assert.match(tools.tools.find(t => t.name === 'finicast_schema')!.description!, /^Call this first/);
  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map(p => p.name), ['finicast_help']);
  const help = await client.getPrompt({ name: 'finicast_help' });
  assert.match((help.messages[0].content as { text: string }).text, /finicast_schema/);
  // rough token budget of the tool definitions (doc 08 §5 targets ~1,300; descriptions with criteria push it higher)
  const chars = JSON.stringify(tools.tools).length;
  assert.ok(chars / 4 < 4000, `tool definitions are ~${Math.round(chars / 4)} tokens`);
  await close();
});

test('schema on an empty database is short and says what to do', async () => {
  const { call, close } = await connect();
  const r = await call('finicast_schema', {});
  assert.match(r.text, /Empty database/);
  assert.ok(r.text.length < 400);
  await close();
});

test('S1 end to end: load, define, set rules, query markdown, explain', async () => {
  const { call, close } = await connect();
  await buildNvda(call);
  // schema now lists everything, including rules
  let r = await call('finicast_schema', { model: 'nvda' });
  assert.match(r.text, /pivot income_statement: line→is_lines\(11\) × period→periods\(6\); measures value; lineDim line, timeDim period; 15 rules/);
  assert.match(r.text, /table financials \(13 rows\): id, account, period→periods, amount:number/);
  // markdown with the numbers from test/nvda.test.ts and E suffix on forecast columns
  r = await call('finicast_query', { model: 'nvda', table: 'income_statement', rows: ['line'], cols: ['period'], formats: { gross_margin: 'percent' } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^## NVDA forecast — income_statement/);
  assert.match(r.text, /\| FY2024 \|\s+FY2025 \|\s+FY2026 \|\s+FY2027E \|\s+FY2028E \|\s+FY2029E \|/);
  assert.match(r.text, /\| Revenue\s+\|\s+60,922 \|\s+130,500 \|\s+180,000 \|\s+252,000 \|\s+352,800 \|\s+493,920 \|/);
  assert.match(r.text, /\| Gross Profit\s+\|\s+44,301 \|/);
  assert.match(r.text, /\| Opex\s+\|\s+11,329 \|/);
  assert.match(r.text, /\| Gross Margin\s+\|\s+72\.7% \|.*75\.0% \|/);
  assert.doesNotMatch(r.text, /more rows/);
  // json format, scale and truncation
  r = await call('finicast_query', { model: 'nvda', table: 'income_statement', rows: ['line'], cols: ['period'], format: 'json', scale: 1000, maxRows: 3 });
  assert.equal(r.json.rows.length, 3);
  assert.equal(r.json.omittedRows, 8);
  assert.ok(Math.abs(r.json.values[0][3] - 252) < 1e-9);
  r = await call('finicast_query', { model: 'nvda', table: 'income_statement', rows: ['line'], cols: ['period'], maxRows: 3, filters: { period: ['fy2024', 'fy2027'] } });
  assert.match(r.text, /… 8 more rows/);
  assert.match(r.text, /\| FY2024 \|\s+FY2027E \|/);
  // explain a rule-governed cell
  r = await call('finicast_explain', { model: 'nvda', table: 'income_statement', at: { line: 'gross_profit', period: 'fy2024' } });
  assert.equal(r.json.value, 60922 - 16621);
  assert.equal(r.json.source, 'rule');
  assert.equal(r.json.rule.text, 'gross_profit = revenue - cogs');
  assert.deepEqual(r.json.precedents.map((p: any) => p.value), [60922, 16621]);
  // an input beats the rule and explain says so
  await call('finicast_set_values', { model: 'nvda', table: 'income_statement', values: [{ at: { line: 'revenue', period: 'fy2027' }, value: 1000 }] });
  r = await call('finicast_explain', { model: 'nvda', table: 'income_statement', at: { line: 'revenue', period: 'fy2027' } });
  assert.equal(r.json.source, 'input');
  assert.equal(r.json.value, 1000);
  r = await call('finicast_explain', { model: 'nvda', table: 'income_statement', at: { line: 'revenue', period: 'fy2028' } });
  assert.equal(r.json.value, 1400);
  assert.match(r.json.rule.text, /PREV\(revenue\)/);
  // tabular explain
  r = await call('finicast_explain', { model: 'nvda', table: 'financials', at: { id: '1' }, measure: 'amount' });
  assert.equal(r.json.value, 60922);
  assert.equal(r.json.row.period, 'fy2024');
  // share in local mode
  r = await call('finicast_share', { model: 'nvda' });
  assert.equal(r.json.url, null);
  assert.match(r.json.message, /not configured/);
  await close();
});

test('a bad rule returns a structured error with a code, and the good rules survive', async () => {
  const { call, close } = await connect();
  await buildNvda(call);
  let r = await call('finicast_set_rules', { model: 'nvda', table: 'income_statement', rules: 'ebit = gross_profit - opexx', replace: false });
  assert.equal(r.isError, true);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.errors[0].code, 'UNKNOWN_NAME');
  assert.match(r.json.errors[0].message, /opexx/);
  assert.ok(r.json.errors[0].fix);
  r = await call('finicast_set_rules', { model: 'nvda', table: 'income_statement', rules: 'ebit = financials.amount', replace: false });
  assert.equal(r.json.errors[0].code, 'SET_IN_SCALAR');
  assert.match(r.json.errors[0].fix, /SUM\(financials\.amount\)/);
  r = await call('finicast_set_rules', { model: 'nvda', table: 'income_statement', rules: 'ebit = = 3', replace: false });
  assert.equal(r.json.errors[0].code, 'PARSE');
  r = await call('finicast_set_rules', { model: 'nvda', table: 'nope', rules: 'x = 1' });
  assert.equal(r.json.errors[0].code, 'SCHEMA_NO_TABLE');
  // the model still computes: invalid rules are skipped
  r = await call('finicast_explain', { model: 'nvda', table: 'income_statement', at: { line: 'ebit', period: 'fy2024' } });
  assert.equal(r.json.value, 60922 - 16621 - 8675 - 2654);
  // non-strict: a rule that fails to parse is stored marked invalid and reported, not thrown
  // (name-resolution errors surface as cell errors at evaluation time in non-strict mode)
  r = await call('finicast_set_rules', { model: 'nvda', table: 'income_statement', rules: 'ebit = = 3', replace: false, strict: false });
  assert.equal(r.json.ok, false);
  assert.match(r.json.compiled[0], /^!! /);
  assert.equal(r.json.errors[0].code, 'RULE_INVALID');
  await close();
});

test('ambiguous group keys come back with a fix, distinctOf and tabular rows work', async () => {
  const { call, close } = await connect();
  await call('finicast_create_model', { model: 'm' });
  await call('finicast_load_table', { model: 'm', table: 'reps', source: { inline: [{ id: 'r1', territory: 'west' }, { id: 'r2', territory: 'east' }] } });
  let r = await call('finicast_load_table', { model: 'm', table: 'deals', source: { csv: 'id,owner,closer,acv\nd1,r1,r2,100\nd2,r2,r2,50\n' }, options: { computed: [{ id: 'double' }] } });
  assert.equal(r.json.fields.find((x: any) => x.id === 'owner').refCandidate, 'reps');
  r = await call('finicast_set_rules', { model: 'm', table: 'deals', rules: 'double = acv * 2' });
  assert.equal(r.json.ok, true, r.text);
  r = await call('finicast_explain', { model: 'm', table: 'deals', at: { id: 'd1' }, measure: 'double' });
  assert.equal(r.json.value, 200);
  await call('finicast_load_table', { model: 'm', table: 'lines', source: { inline: [{ id: 'bookings' }] } });
  r = await call('finicast_define_pivot', { model: 'm', table: 'by_territory', dims: [{ id: 'territory', from: { distinctOf: 'reps.territory' } }, { id: 'line', from: 'lines' }] });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.dims[0].members, 2);
  assert.equal(r.json.lineDim, 'territory'); // first dim by default when nothing marks a line dim
  r = await call('finicast_define_pivot', { model: 'm', table: 'by_rep', dims: [{ id: 'rep', from: 'reps' }, { id: 'line', from: 'lines' }], lineDim: 'line' });
  r = await call('finicast_set_rules', { model: 'm', table: 'by_rep', rules: 'bookings = SUM(deals.acv)' });
  assert.equal(r.json.errors[0].code, 'AMBIGUOUS_GROUP_KEY');
  assert.equal(r.json.errors[0].fix, 'deals.acv[owner=@rep]');
  r = await call('finicast_set_rules', { model: 'm', table: 'by_rep', rules: `bookings = SUM(${r.json.errors[0].fix})` });
  assert.equal(r.json.ok, true, r.text);
  r = await call('finicast_set_values', { model: 'm', table: 'deals', rows: [{ id: 'd1', acv: 120 }, { id: 'd3', owner: 'r1', closer: 'r1', acv: 30 }] });
  assert.deepEqual([r.json.set, r.json.inserted], [1, 1]);
  r = await call('finicast_query', { model: 'm', table: 'by_rep', rows: ['rep'], cols: ['line'] });
  assert.match(r.text, /\| r1\s+\|\s+150 \|/);
  // a text column with a distinctOf dimension needs an explicit correlation (no ref path exists)
  r = await call('finicast_set_rules', { model: 'm', table: 'by_territory', rules: 'value[line=bookings] = SUM(deals.acv[owner.territory=@territory])' });
  assert.equal(r.json.ok, true, r.text);
  r = await call('finicast_query', { model: 'm', table: 'by_territory', rows: ['territory'], cols: ['line'] });
  assert.match(r.text, /\| west\s+\|\s+150 \|/);
  assert.match(r.text, /\| east\s+\|\s+50 \|/);
  await close();
});
