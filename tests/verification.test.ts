import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';

const PARAMS = [
  { id: 'f_mes', name: 'Mes', slug: 'mes', type: 'date/month-year' },
  { id: 'f_tier', name: 'Tier', slug: 'tier', type: 'string/=' },
];
const m = (pid: string, cid: number, tag: string) => ({ parameter_id: pid, card_id: cid, target: ['variable', ['template-tag', tag]] });

const dashboard = () => ({
  id: 621,
  parameters: PARAMS,
  tabs: [{ id: 11, name: 'Cambios', position: 1 }, { id: 10, name: 'Ranking', position: 0 }],
  dashcards: [
    { id: 3, card_id: 6608, dashboard_tab_id: 11, row: 0, col: 0, card: { name: 'Tiers', display: 'table', dataset_query: { database: 40, _card: 6608 } }, parameter_mappings: [m('f_mes', 6608, 'p_mes')] },
    { id: 2, card_id: 6601, dashboard_tab_id: 10, row: 2, col: 6, card: { name: 'Clientes', display: 'table', dataset_query: { database: 40, _card: 6601 } },
      visualization_settings: { 'card.hide_empty': true },
      parameter_mappings: [m('f_mes', 6601, 'p_mes'), m('f_tier', 6601, 'p_tier')] },
    { id: 1, card_id: 6600, dashboard_tab_id: 10, row: 0, col: 16, card: { name: 'Mes que estás viendo', display: 'table', dataset_query: { database: 40, _card: 6600 } }, parameter_mappings: [m('f_mes', 6600, 'p_mes')] },
    { id: 4, card_id: null, dashboard_tab_id: 10, row: 0, col: 0, visualization_settings: { virtual_card: { display: 'text' }, text: '## T' } },
    { id: 5, card_id: 6612, dashboard_tab_id: 11, row: 5, col: 0, card: { name: 'Rota', display: 'table', dataset_query: { database: 40, _card: 6612 } }, parameter_mappings: [] },
  ],
});

function client(answers: Record<number, any> = {}) {
  const c = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (c as any).axiosInstance;
  let inFlight = 0;
  let maxInFlight = 0;
  ax.get = vi.fn(async () => ({ data: dashboard() }));
  ax.post = vi.fn(async (url: string, body: any) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (url === '/api/dataset' && body?._card === undefined) return answers[0];
    // runDashcards runs each card's own query ad hoc; _card marks which one.
    const cid = url === '/api/dataset' ? body._card : Number(/card\/(\d+)\/query$/.exec(url)![1]);
    const answer = answers[cid] ?? { status: 'completed', data: { rows: [[1], [2]] } };
    if (answer instanceof Error) throw answer;
    return { data: answer };
  });
  return { c, ax, maxInFlight: () => maxInFlight };
}

describe('runDashcards', () => {
  const ran = (ax: any) => ax.post.mock.calls.map(([, body]: [string, any]) => body._card);

  it('runs every question in tab → row → col order as an ad hoc query, skipping text', async () => {
    const { c, ax } = client();
    const result = await c.runDashcards(621);
    expect(ran(ax)).toEqual([6600, 6601, 6608, 6612]);
    expect(ax.post.mock.calls.every(([url]: [string]) => url === '/api/dataset')).toBe(true);
    expect(result.cards[0]).toEqual({
      tab: 'Ranking', dashcard_id: 1, card_id: 6600, name: 'Mes que estás viendo', display: 'table', hide_empty: false, status: 'ok', rows: 2,
    });
    // Without values nothing is sent.
    expect(ax.post.mock.calls.every(([, body]: [string, any]) => body.parameters.length === 0)).toBe(true);
  });

  it("never calls the dashcard endpoint, which would save the values as the user's last-used filters", async () => {
    const { c, ax } = client();
    await c.runDashcards(621, { values: { f_mes: '2026-12' } });
    expect(ax.post.mock.calls.some(([url]: [string]) => url.includes('/dashcard/'))).toBe(false);
  });

  it('sends only the mapped filters that have a value, with the dashboard filter type', async () => {
    const { c, ax } = client();
    await c.runDashcards(621, { values: { f_mes: '2026-12', f_tier: 'Muy Alta' } });
    const bodyFor = (cid: number) => ax.post.mock.calls.find(([, b]: [string, any]) => b._card === cid)[1];
    expect(bodyFor(6601).parameters).toEqual([
      { id: 'f_mes', type: 'date/month-year', target: ['variable', ['template-tag', 'p_mes']], value: '2026-12' },
      { id: 'f_tier', type: 'string/=', target: ['variable', ['template-tag', 'p_tier']], value: ['Muy Alta'] },
    ]);
    expect(bodyFor(6600).parameters).toEqual([
      { id: 'f_mes', type: 'date/month-year', target: ['variable', ['template-tag', 'p_mes']], value: '2026-12' },
    ]);
    expect(bodyFor(6612).parameters).toEqual([]);
  });

  it('keeps a list value for string filters as it comes', async () => {
    const { c, ax } = client();
    await c.runDashcards(621, { values: { f_tier: ['Alta', 'Media'] } });
    const body = ax.post.mock.calls.find(([, b]: [string, any]) => b._card === 6601)[1];
    expect(body.parameters[0].value).toEqual(['Alta', 'Media']);
  });

  it('reports ok, empty and error with totals, truncating long errors', async () => {
    const { c } = client({
      6601: { status: 'completed', data: { rows: [] } },
      6608: { status: 'failed', error: 'x'.repeat(1000) },
      6612: Object.assign(new Error('Request failed'), { response: { data: { message: 'column "nicho" does not exist' } } }),
    });
    const result = await c.runDashcards(621);
    const byId = Object.fromEntries(result.cards.map((r: any) => [r.dashcard_id, r]));
    expect(byId[2]).toMatchObject({ status: 'empty', rows: 0, hide_empty: true });
    expect(byId[3].status).toBe('error');
    expect(byId[3].error.length).toBeLessThanOrEqual(301);
    expect(byId[5]).toMatchObject({ status: 'error', error: 'column "nicho" does not exist' });
    expect(result.totals).toEqual({ ok: 1, empty: 1, chart_errors: 0, errors: 2 });
  });

  it('flags a card whose result does not fit its chart, though the query runs', async () => {
    const { c } = client({
      6601: { status: 'completed', data: { rows: [[1, 2]], cols: [{ name: 'Tier', base_type: 'type/Text' }, { name: 'Clientes', base_type: 'type/Integer' }] } },
    });
    const d = dashboard();
    d.dashcards[1].card = { name: 'Clientes', display: 'smartscalar', dataset_query: { database: 40, _card: 6601 } } as any;
    (c as any).axiosInstance.get = vi.fn(async () => ({ data: d }));
    const result = await c.runDashcards(621);
    const card = result.cards.find((r: any) => r.dashcard_id === 2);
    expect(card.status).toBe('chart_error');
    expect(card.chart_errors[0]).toMatch(/trend card needs a date column/);
    expect(result.totals.chart_errors).toBe(1);
    expect(result.checks).toMatch(/not inspected/);
  });

  it('runs one tab, by name or id', async () => {
    const { c, ax } = client();
    await c.runDashcards(621, { tab: 'cambios' });
    expect(ax.post).toHaveBeenCalledTimes(2);
    const { c: c2, ax: ax2 } = client();
    await c2.runDashcards(621, { tab: 10 });
    expect(ax2.post).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown tab or filter', async () => {
    const { c } = client();
    await expect(c.runDashcards(621, { tab: 'Nope' })).rejects.toThrow(/Tab "Nope".*10 \(Ranking\)/);
    await expect(c.runDashcards(621, { values: { f_x: 1 } })).rejects.toThrow(/f_x/);
  });

  it('never runs more than 3 queries at once', async () => {
    const { c, maxInFlight } = client();
    await c.runDashcards(621);
    expect(maxInFlight()).toBeLessThanOrEqual(3);
  });
});

describe('testNativeQuery', () => {
  const SQL = 'SELECT * FROM r WHERE mes = {{p_mes}} [[AND tier = {{p_tier}}]]';

  it('sends an MBQL 5 query with a tag per variable and the values as dashboard filters', async () => {
    const { c, ax } = client({ 0: { data: { status: 'completed', row_count: 1, data: { rows: [[1]], cols: [{ name: 'n', display_name: 'N' }], native_form: { query: "SELECT ... '2026-09-01'" } } } } });
    const result = await c.testNativeQuery(40, SQL, {
      templateTags: { p_mes: { type: 'date' } },
      values: { p_mes: '2026-09', p_tier: 'Alta' },
      filterTypes: { p_mes: 'date/month-year', p_tier: 'string/=' },
    });
    const [url, body] = ax.post.mock.calls[0];
    expect(url).toBe('/api/dataset');
    expect(body).toEqual({
      'lib/type': 'mbql/query',
      database: 40,
      stages: [{
        'lib/type': 'mbql.stage/native',
        native: SQL,
        'template-tags': [
          { id: 'p_mes-test', name: 'p_mes', 'display-name': 'p_mes', type: 'date' },
          { id: 'p_tier-test', name: 'p_tier', 'display-name': 'p_tier', type: 'text' },
        ],
      }],
      parameters: [
        { type: 'date/month-year', value: '2026-09', target: ['variable', ['template-tag', 'p_mes']] },
        { type: 'string/=', value: ['Alta'], target: ['variable', ['template-tag', 'p_tier']] },
      ],
    });
    expect(result).toEqual({
      status: 'ok', columns: ['N'], rows: [[1]], row_count: 1, truncated: false, native_sql: "SELECT ... '2026-09-01'",
    });
  });

  it('defaults the filter type from the variable type and leaves out variables without value', async () => {
    const { c, ax } = client({ 0: { data: { status: 'completed', data: { rows: [], cols: [] } } } });
    const result = await c.testNativeQuery(40, SQL, { templateTags: { p_mes: { type: 'date' } }, values: { p_mes: '2026-09-01' } });
    expect(ax.post.mock.calls[0][1].parameters).toEqual([
      { type: 'date/single', value: '2026-09-01', target: ['variable', ['template-tag', 'p_mes']] },
    ]);
    expect(result.status).toBe('empty');
  });

  it('returns only the first rows', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i]);
    const { c } = client({ 0: { data: { status: 'completed', row_count: 50, data: { rows, cols: [{ name: 'i' }] } } } });
    const result = await c.testNativeQuery(40, 'SELECT i', { limitRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.row_count).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it('returns the error of a failed query instead of throwing', async () => {
    const { c } = client({ 0: { data: { status: 'failed', error: 'syntax error at or near "FORM"' } } });
    expect(await c.testNativeQuery(40, 'SELECT * FORM x')).toEqual({ status: 'error', error: 'syntax error at or near "FORM"' });
  });

  it('refuses a value for a variable the query does not have', async () => {
    const { c } = client();
    await expect(c.testNativeQuery(40, 'SELECT 1', { values: { p_mes: 'x' } })).rejects.toThrow(/\{\{p_mes\}\}/);
  });

  it('runs a MongoDB pipeline in the legacy format with its collection', async () => {
    const { c, ax } = client({ 0: { data: { status: 'completed', data: { rows: [['a']], cols: [{ name: '_id' }] } } } });
    await c.testNativeQuery(34, '[{"$limit":1}]', { collection: 'hubspot_associations' });
    expect(ax.post.mock.calls[0][1]).toEqual({
      type: 'native', database: 34, native: { query: '[{"$limit":1}]', collection: 'hubspot_associations' }, parameters: [],
    });
  });
});

describe('verification tools', async () => {
  const { addDashboardTools } = await import('../src/tools/dashboard-tools.js');
  const { addDatabaseTools } = await import('../src/tools/database-tools.js');
  const tools = new Map<string, any>();
  const server = { addTool: (t: any) => tools.set(t.name, t) } as any;
  addDashboardTools(server, () => ({}) as any);
  addDatabaseTools(server, () => ({}) as any);

  it.each(['run_dashcards', 'test_native_query'])('%s is an essential read tool', (name) => {
    expect(tools.get(name).metadata).toEqual({ isRead: true, isEssential: true });
  });
});
