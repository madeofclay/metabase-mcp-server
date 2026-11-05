import { describe, it, expect, vi } from 'vitest';
import { AxiosError } from 'axios';
import { validateVisualization, effectiveSettings } from '../src/utils/viz-validation.js';
import { cardSummary, cardOutput, dashboardOutput } from '../src/utils/compact-result.js';
import { MetabaseClient, createdDashcardIds } from '../src/client/metabase-client.js';
import { addCardTools } from '../src/tools/card-tools.js';

const col = (name: string, base_type: string) => ({ name, base_type });
const MES = col('Mes', 'type/Date');
const N = col('Clientes', 'type/BigInteger');
const TXT = col('Tier', 'type/Text');

describe('validateVisualization', () => {
  it('a trend card needs a date column and a number', () => {
    expect(validateVisualization('smartscalar', {}, [MES, N]).errors).toEqual([]);
    expect(validateVisualization('smartscalar', {}, [TXT, N]).errors[0]).toMatch(/needs a date column/);
    expect(validateVisualization('smartscalar', {}, [MES, TXT]).errors[0]).toMatch(/numeric column/);
  });

  it('a trend card compared against another column still needs a date column, and that column', () => {
    const vs = { 'scalar.comparisons': [{ type: 'anotherColumn', column: 'Meta' }] };
    const errs = validateVisualization('smartscalar', vs, [TXT, N]).errors.join(' ');
    expect(errs).toMatch(/«Meta», which the query does not return/);
    expect(errs).toMatch(/still needs the trend card to have a date column/);
  });

  it('scalar.field must exist and, on a trend card, be numeric', () => {
    expect(validateVisualization('scalar', { 'scalar.field': 'X' }, [N]).errors[0]).toMatch(/«X»/);
    expect(validateVisualization('smartscalar', { 'scalar.field': 'Mes' }, [MES, N]).errors[0]).toMatch(/not numeric/);
  });

  it('graph charts: dimensions and metrics must exist, metrics must be numeric', () => {
    expect(validateVisualization('bar', { 'graph.dimensions': ['Tier'], 'graph.metrics': ['Clientes'] }, [TXT, N]).errors).toEqual([]);
    expect(validateVisualization('bar', { 'graph.dimensions': ['Nicho'], 'graph.metrics': ['Clientes'] }, [TXT, N]).errors[0]).toMatch(/graph\.dimensions names «Nicho»/);
    expect(validateVisualization('line', { 'graph.metrics': ['Tier'] }, [TXT, N]).errors[0]).toMatch(/must be numeric/);
    expect(validateVisualization('row', {}, [N]).errors[0]).toMatch(/at least two columns/);
    expect(validateVisualization('bar', {}, [TXT, TXT]).errors[0]).toMatch(/numeric column/);
  });

  it('pie and gauge', () => {
    expect(validateVisualization('pie', { 'pie.dimension': 'Tier', 'pie.metric': 'Clientes' }, [TXT, N]).errors).toEqual([]);
    expect(validateVisualization('pie', { 'pie.metric': 'Tier' }, [TXT, N]).errors[0]).toMatch(/must be numeric/);
    expect(validateVisualization('gauge', {}, [TXT]).errors[0]).toMatch(/numeric column/);
  });

  it('warns when settings format columns the query no longer returns', () => {
    const vs = { column_settings: { '["name","Viejo"]': { suffix: ' UF' } }, 'table.columns': [{ name: 'Otro', enabled: true }] };
    const { errors, warnings } = validateVisualization('table', vs, [TXT, N]);
    expect(errors).toEqual([]);
    expect(warnings.join(' ')).toMatch(/«Viejo».*ignored/);
    expect(warnings.join(' ')).toMatch(/table\.columns lists «Otro»/);
  });

  it('tables and empty column lists pass', () => {
    expect(validateVisualization('table', {}, [TXT])).toEqual({ errors: [], warnings: [] });
    expect(validateVisualization('smartscalar', {}, [])).toEqual({ errors: [], warnings: [] });
  });

  it('effectiveSettings: the dashcard overrides the card, column_settings merge per column', () => {
    const merged = effectiveSettings(
      { 'graph.metrics': ['A'], column_settings: { '["name","A"]': { suffix: ' UF' } } },
      { 'card.hide_empty': true, column_settings: { '["name","B"]': { decimals: 0 } } },
    );
    expect(merged).toEqual({
      'graph.metrics': ['A'], 'card.hide_empty': true,
      column_settings: { '["name","A"]': { suffix: ' UF' }, '["name","B"]': { decimals: 0 } },
    });
  });
});

describe('card summaries', () => {
  const card = {
    id: 6615, name: 'Clientes en el ranking', display: 'smartscalar', collection_id: 548, database_id: 40,
    query_type: 'native', dashboard_count: 1,
    visualization_settings: { 'scalar.field': 'Clientes' },
    dataset_query: { stages: [{ 'template-tags': [{ name: 'p_mes', type: 'date' }, { name: 'p_tier', type: 'text' }] }] },
    result_metadata: [TXT, N],
    big: 'x'.repeat(20000),
  };

  it('reports the columns, the template tags and a chart that will not render', () => {
    const s = cardSummary(card);
    expect(s).toMatchObject({
      id: 6615, display: 'smartscalar', template_tags: [{ name: 'p_mes', type: 'date' }, { name: 'p_tier', type: 'text' }],
      columns: [{ name: 'Tier', type: 'type/Text' }, { name: 'Clientes', type: 'type/BigInteger' }],
    });
    expect(s.chart_errors[0]).toMatch(/needs a date column/);
    expect(s).not.toHaveProperty('big');
  });

  it('cardOutput is short unless include_full, and handles update_card with sql', () => {
    expect(cardOutput(card).length).toBeLessThan(2000);
    expect(cardOutput(card, true)).toContain('x'.repeat(100));
    const fromSql = JSON.parse(cardOutput({ card, template_tags: [], format: 'mbql5' }));
    expect(fromSql.card.id).toBe(6615);
    expect(fromSql.format).toBe('mbql5');
  });

  it('get_dashboard output lists the cards in tab order, without their queries', () => {
    const d = {
      id: 1, name: 'D', tabs: [{ id: 2, name: 'B', position: 1 }, { id: 1, name: 'A', position: 0 }],
      parameters: [{ id: 'f', name: 'F', slug: 'f', type: 'string/=' }],
      dashcards: [
        { id: 20, card_id: 9, dashboard_tab_id: 2, row: 0, col: 0, size_x: 6, size_y: 3, card: { name: 'Y', dataset_query: 'x'.repeat(5000) } },
        { id: 10, card_id: 8, dashboard_tab_id: 1, row: 0, col: 0, size_x: 6, size_y: 3, card: { name: 'X' } },
      ],
    };
    const out = JSON.parse(dashboardOutput(d));
    expect(out.cards.map((c: any) => c.id)).toEqual([10, 20]);
    expect(out.cards[0]).toMatchObject({ card_id: 8, name: 'X', tab: 1 });
    expect(JSON.stringify(out)).not.toContain('xxxxx');
    expect(JSON.parse(dashboardOutput(d, true)).dashcards).toHaveLength(2);
  });
});

describe('createdDashcardIds', () => {
  it('matches each new dashcard to the stored one by tab, position, size and card', () => {
    const layoutTabs = [{ id: -1, name: 'A' }, { id: 7, name: 'B' }];
    const storedTabs = [{ id: 30, name: 'A', position: 0 }, { id: 7, name: 'B', position: 1 }];
    const layout = [
      { id: -101, card_id: null, dashboard_tab_id: -1, row: 0, col: 0, size_x: 24, size_y: 1 },
      { id: -102, card_id: 5, dashboard_tab_id: -1, row: 1, col: 0, size_x: 6, size_y: 3 },
      { id: 50, card_id: 6, dashboard_tab_id: 7, row: 0, col: 0, size_x: 6, size_y: 3 },
      { id: -103, card_id: 5, dashboard_tab_id: 7, row: 0, col: 6, size_x: 6, size_y: 3 },
    ];
    const stored = [
      { id: 50, card_id: 6, dashboard_tab_id: 7, row: 0, col: 0, size_x: 6, size_y: 3 },
      { id: 902, card_id: 5, dashboard_tab_id: 30, row: 1, col: 0, size_x: 6, size_y: 3 },
      { id: 901, card_id: null, dashboard_tab_id: 30, row: 0, col: 0, size_x: 24, size_y: 1 },
      { id: 903, card_id: 5, dashboard_tab_id: 7, row: 0, col: 6, size_x: 6, size_y: 3 },
    ];
    expect(createdDashcardIds(layoutTabs, storedTabs, layout, stored)).toEqual([
      { temp_id: -101, id: 901, card_id: null, tab: 30 },
      { temp_id: -102, id: 902, card_id: 5, tab: 30 },
      { temp_id: -103, id: 903, card_id: 5, tab: 7 },
    ]);
  });

  it('leaves id null when no stored dashcard matches', () => {
    expect(createdDashcardIds([], [], [{ id: -1, card_id: 1, row: 0, col: 0, size_x: 1, size_y: 1 }], [])[0].id).toBeNull();
  });
});

function fakeClient(dashboard: any) {
  const c = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'k' });
  const ax = (c as any).axiosInstance;
  ax.get = vi.fn(async (url: string) => (url.startsWith('/api/revision') ? { data: [{ id: 5 }] } : { data: dashboard }));
  ax.put = vi.fn(async (_url: string, body: any) => ({ data: { ...dashboard, ...body } }));
  return { c, ax };
}

describe('update_dashcard merges visualization settings', () => {
  const dashboard = () => ({
    id: 1, tabs: [], parameters: [],
    dashcards: [{ id: 9, card_id: null, row: 0, col: 0, size_x: 24, size_y: 1,
      visualization_settings: { virtual_card: { display: 'heading' }, text: '#### Viejo', 'dashcard.background': false } }],
  });

  it('changes only the keys sent', async () => {
    const { c, ax } = fakeClient(dashboard());
    await c.updateDashcard(1, 9, { visualization_settings: { text: '#### Nuevo' } });
    const sent = ax.put.mock.calls[0][1].dashcards[0].visualization_settings;
    expect(sent).toEqual({ virtual_card: { display: 'heading' }, text: '#### Nuevo', 'dashcard.background': false });
  });

  it('replaces them whole when asked', async () => {
    const { c, ax } = fakeClient(dashboard());
    await c.updateDashcard(1, 9, { visualization_settings: { text: 'x' } }, { replaceVisualizationSettings: true });
    expect(ax.put.mock.calls[0][1].dashcards[0].visualization_settings).toEqual({ text: 'x' });
  });
});

function clientAnswering(handler: (config: any) => { status: number; data: any; headers?: any }) {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'k' });
  (client as any).axiosInstance.defaults.adapter = async (config: any) => {
    const r = handler(config);
    const response = { status: r.status, statusText: '', data: r.data, headers: r.headers || {}, config };
    if (r.status >= 400) throw new AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_REQUEST', config, null, response as any);
    return response;
  };
  return client;
}

describe('other 4xx errors say what Metabase answered', () => {
  it('a 400 keeps the status line and adds the request and the detail', async () => {
    const client = clientAnswering(() => ({ status: 400, data: { message: 'Invalid parameter value for p_mes' } }));
    await expect(client.getCard(7)).rejects.toThrow(
      /Request failed with status code 400 \(GET \/api\/card\/7\)\. Metabase said: "Invalid parameter value for p_mes"/
    );
  });
});

describe('preview_card', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('returns the PNG as image content', async () => {
    const client = clientAnswering((cfg) => {
      expect(cfg.url).toBe('/api/pulse/preview_card_png/6615');
      return { status: 200, data: PNG, headers: { 'content-type': 'image/png' } };
    });
    const tools: Record<string, any> = {};
    addCardTools({ addTool: (t: any) => { tools[t.name] = t; } }, () => client);
    const out = await tools.preview_card.execute({ card_id: 6615 }, {});
    expect(out.content[1]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    expect(out.content[0].text).toMatch(/Card 6615 rendered/);
  });

  it('says so when Metabase answers something that is not an image', async () => {
    const client = clientAnswering(() => ({ status: 200, data: Buffer.from('<html>error</html>'), headers: { 'content-type': 'text/html' } }));
    await expect(client.previewCardPng(1)).rejects.toThrow(/did not return an image for card 1 \(text\/html\)/);
  });
});
