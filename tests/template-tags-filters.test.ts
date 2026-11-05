import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';
import { buildTemplateTags, variableNames } from '../src/utils/template-tags.js';
import { addCardTools } from '../src/tools/card-tools.js';

const SQL = `SELECT * FROM ranking
WHERE mes = {{p_mes}}
[[AND tier = {{p_tier}}]]
[[AND tier = {{ p_tier }}]]
AND x IN {{snippet: clientes activos}}
AND y IN (SELECT id FROM {{#123-base-clientes}})`;

describe('template tag detection', () => {
  it('finds variables, also inside [[ ]], once each, and ignores snippets and card references', () => {
    expect(variableNames(SQL)).toEqual(['p_mes', 'p_tier']);
  });

  it('builds new tags as text with a stable id, unless told otherwise', () => {
    const tags = buildTemplateTags(SQL, 6600, { p_mes: { type: 'date', display_name: 'Mes' } });
    expect(tags).toEqual([
      { id: 'p_mes-6600', name: 'p_mes', 'display-name': 'Mes', type: 'date' },
      { id: 'p_tier-6600', name: 'p_tier', 'display-name': 'p_tier', type: 'text' },
    ]);
  });

  it('keeps the id and type of a variable that already had a tag, and the reference tags in use', () => {
    const existing = [
      { id: 'uuid-1', name: 'p_mes', 'display-name': 'Mes', type: 'date' },
      { id: 'uuid-2', name: 'gone', 'display-name': 'Gone', type: 'text' },
      { id: 'uuid-3', name: 'snippet: clientes activos', 'display-name': 'S', type: 'snippet', 'snippet-id': 4 },
      { id: 'uuid-4', name: '#123-base-clientes', 'display-name': 'C', type: 'card', 'card-id': 123 },
    ];
    const tags = buildTemplateTags(SQL, 6600, {}, existing);
    expect(tags.map((t) => t.name)).toEqual(['p_mes', 'p_tier', 'snippet: clientes activos', '#123-base-clientes']);
    expect(tags[0]).toEqual(existing[0]);
    expect(tags[2]).toEqual(existing[2]);
  });

  it('lets template_tags change an existing tag type', () => {
    const tags = buildTemplateTags('SELECT {{n}}', 1, { n: { type: 'number' } }, [{ id: 'u', name: 'n', 'display-name': 'n', type: 'text' }]);
    expect(tags[0]).toMatchObject({ id: 'u', type: 'number' });
  });

  it('refuses template_tags for a variable the SQL does not have', () => {
    expect(() => buildTemplateTags('SELECT 1', 1, { p_mes: { type: 'date' } })).toThrow(/no \{\{p_mes\}\}/);
  });
});

// ── Cards ────────────────────────────────────────────────────────────────────

function cardClient(card: any) {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (client as any).axiosInstance;
  ax.get = vi.fn(async (url: string) => {
    if (url === `/api/card/${card.id}`) return { data: structuredClone(card) };
    throw new Error(`unexpected GET ${url}`);
  });
  ax.put = vi.fn(async (_url: string, body: any) => ({ data: { ...card, ...body } }));
  ax.post = vi.fn(async (_url: string, body: any) => ({ data: { id: 1, ...body } }));
  return { client, ax };
}

// What 0.63 returns from GET /api/card/:id for a native question.
const mbql5Card = () => ({
  id: 6600,
  name: 'Mes que estás viendo',
  dataset_query: {
    'lib/type': 'mbql/query',
    database: 40,
    stages: [{
      'lib/type': 'mbql.stage/native',
      native: 'SELECT {{p_mes}}',
      'template-tags': [{ id: 'kept-uuid', name: 'p_mes', 'display-name': 'Mes', type: 'date' }],
    }],
  },
});

describe('updateCardSql', () => {
  it('rewrites an MBQL 5 query in place, tags as a list, keeping known tags', async () => {
    const { client, ax } = cardClient(mbql5Card());
    const result = await client.updateCardSql(6600, 'SELECT {{p_mes}}, {{p_tier}}');
    const [url, body] = ax.put.mock.calls[0];
    expect(url).toBe('/api/card/6600');
    const stage = body.dataset_query.stages[0];
    expect(body.dataset_query['lib/type']).toBe('mbql/query');
    expect(body.dataset_query.database).toBe(40);
    expect(stage['lib/type']).toBe('mbql.stage/native');
    expect(stage.native).toBe('SELECT {{p_mes}}, {{p_tier}}');
    expect(stage['template-tags']).toEqual([
      { id: 'kept-uuid', name: 'p_mes', 'display-name': 'Mes', type: 'date' },
      { id: 'p_tier-6600', name: 'p_tier', 'display-name': 'p_tier', type: 'text' },
    ]);
    expect(result.format).toBe('mbql5');
  });

  it('rewrites a legacy query with tags as an object', async () => {
    const legacy = { id: 7, dataset_query: { type: 'native', database: 40, native: { query: 'SELECT 1', 'template-tags': {} } } };
    const { client, ax } = cardClient(legacy);
    await client.updateCardSql(7, 'SELECT {{n}}', { n: { type: 'number' } }, { name: 'Renombrada' });
    const body = ax.put.mock.calls[0][1];
    expect(body.name).toBe('Renombrada');
    expect(body.dataset_query.native.query).toBe('SELECT {{n}}');
    expect(body.dataset_query.native['template-tags']).toEqual({ n: { id: 'n-7', name: 'n', 'display-name': 'n', type: 'number' } });
  });

  it('refuses a card that is not native SQL', async () => {
    const { client } = cardClient({ id: 8, dataset_query: { type: 'query', query: { 'source-table': 1 } } });
    await expect(client.updateCardSql(8, 'SELECT 1')).rejects.toThrow(/not a native SQL question/);
  });
});

describe('card tools', () => {
  function tools(client: any) {
    const map = new Map<string, any>();
    addCardTools({ addTool: (t: any) => map.set(t.name, t) }, () => client);
    return map;
  }

  it('create_card declares the variables as legacy template tags', async () => {
    const { client } = cardClient(mbql5Card());
    const createCard = vi.fn(async (payload: any) => payload);
    (client as any).createCard = createCard;
    await tools(client).get('create_card').execute(
      { name: 'x', database_id: 40, query: SQL, template_tags: { p_mes: { type: 'date', display_name: 'Mes' } } }, {},
    );
    const native = createCard.mock.calls[0][0].dataset_query.native;
    expect(native.query).toBe(SQL);
    expect(native['template-tags']).toEqual({
      p_mes: { id: 'p_mes-new', name: 'p_mes', 'display-name': 'Mes', type: 'date' },
      p_tier: { id: 'p_tier-new', name: 'p_tier', 'display-name': 'p_tier', type: 'text' },
    });
  });

  it('update_card takes the sql shortcut', async () => {
    const { client, ax } = cardClient(mbql5Card());
    const out = JSON.parse(await tools(client).get('update_card').execute({ card_id: 6600, sql: 'SELECT {{p_mes}}' }, {}));
    expect(out.template_tags).toEqual([{ name: 'p_mes', type: 'date', id: 'kept-uuid' }]);
    expect(ax.put).toHaveBeenCalledTimes(1);
  });

  it('update_card still takes plain updates', async () => {
    const { client, ax } = cardClient(mbql5Card());
    await tools(client).get('update_card').execute({ card_id: 6600, updates: { name: 'Otra' } }, {});
    expect(ax.put.mock.calls[0][1]).toEqual({ name: 'Otra' });
  });
});

// ── Dashboard filters ────────────────────────────────────────────────────────

const PARAMS = [
  { id: 'f_mes', name: 'Mes', slug: 'mes', type: 'date/month-year', sectionId: 'date' },
  { id: 'f_tier', name: 'Tier', slug: 'tier', type: 'string/=', sectionId: 'string',
    values_query_type: 'list', values_source_type: 'static-list', values_source_config: { values: ['Muy Alta', 'Alta'] } },
];
const nativeCard = (id: number, tags: [string, string][]) => ({
  id,
  dataset_query: {
    'lib/type': 'mbql/query', database: 40,
    stages: [{ 'lib/type': 'mbql.stage/native', native: 'SELECT 1',
      'template-tags': tags.map(([name, type]) => ({ id: `${name}-${id}`, name, 'display-name': name, type })) }],
  },
});

function dashboardClient(dashboard: any, cards: Record<number, any> = {}) {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (client as any).axiosInstance;
  ax.get = vi.fn(async (url: string) => {
    if (url === `/api/dashboard/${dashboard.id}`) return { data: structuredClone(dashboard) };
    if (url === `/api/revision/dashboard/${dashboard.id}`) return { data: [{ id: 3 }] };
    const m = /^\/api\/card\/(\d+)$/.exec(url);
    if (m && cards[+m[1]]) return { data: cards[+m[1]] };
    throw new Error(`unexpected GET ${url}`);
  });
  ax.put = vi.fn(async (_url: string, body: any) => ({ data: body }));
  return { client, ax, sent: () => ax.put.mock.calls[0]?.[1] };
}

const rankingDashboard = () => ({
  id: 621,
  parameters: [{ id: 'old', name: 'Viejo', slug: 'viejo', type: 'string/=' }],
  tabs: [],
  dashcards: [
    // The GET embeds the card: its tags come from there.
    { id: 1, card_id: 6600, row: 0, col: 0, size_x: 8, size_y: 2, card: nativeCard(6600, [['p_mes', 'date']]),
      parameter_mappings: [{ parameter_id: 'old', card_id: 6600, target: ['variable', ['template-tag', 'x']] }] },
    { id: 2, card_id: 6601, row: 2, col: 0, size_x: 6, size_y: 3, card: nativeCard(6601, [['p_mes', 'date'], ['p_tier', 'text']]),
      parameter_mappings: [] },
    // No embedded card: fetched.
    { id: 3, card_id: 6602, row: 5, col: 0, size_x: 6, size_y: 3, parameter_mappings: [] },
    { id: 4, card_id: null, row: 8, col: 0, size_x: 24, size_y: 1,
      visualization_settings: { virtual_card: { display: 'heading' }, text: '## T' }, parameter_mappings: [] },
  ],
});

describe('setDashboardFilters', () => {
  const mapByTag = { f_mes: 'p_mes', f_tier: 'p_tier' };

  it('maps each filter to the cards that have its variable, without a third target element', async () => {
    const { client, sent } = dashboardClient(rankingDashboard(), { 6602: nativeCard(6602, [['p_tier', 'text']]) });
    const result = await client.setDashboardFilters(621, PARAMS, mapByTag);
    const byId = Object.fromEntries(sent().dashcards.map((d: any) => [d.id, d.parameter_mappings]));
    expect(byId[1]).toEqual([{ parameter_id: 'f_mes', card_id: 6600, target: ['variable', ['template-tag', 'p_mes']] }]);
    expect(byId[2]).toEqual([
      { parameter_id: 'f_mes', card_id: 6601, target: ['variable', ['template-tag', 'p_mes']] },
      { parameter_id: 'f_tier', card_id: 6601, target: ['variable', ['template-tag', 'p_tier']] },
    ]);
    expect(byId[3]).toEqual([{ parameter_id: 'f_tier', card_id: 6602, target: ['variable', ['template-tag', 'p_tier']] }]);
    expect(byId[4]).toEqual([]);
    expect(sent().parameters).toEqual(PARAMS);
    expect(result.mappings.find((m: any) => m.dashcard_id === 1)).toEqual({
      dashcard_id: 1, card_id: 6600, mapped: [{ parameter_id: 'f_mes', tag: 'p_mes' }], not_applicable: ['f_tier'], excluded: [],
    });
    // The mapping to the removed filter "old" would break the dashboard.
    expect(result.dropped_mappings).toBe(1);
  });

  it('keeps mappings of filters it does not manage', async () => {
    const dash = rankingDashboard();
    dash.dashcards[1].parameter_mappings = [{ parameter_id: 'f_nicho', card_id: 6601, target: ['variable', ['template-tag', 'p_nicho']] }];
    const params = [...PARAMS, { id: 'f_nicho', name: 'Nicho', slug: 'nicho', type: 'string/=' }];
    const { client, sent } = dashboardClient(dash, { 6602: nativeCard(6602, []) });
    await client.setDashboardFilters(621, params, mapByTag);
    const card2 = sent().dashcards.find((d: any) => d.id === 2).parameter_mappings;
    expect(card2.map((m: any) => m.parameter_id)).toEqual(['f_nicho', 'f_mes', 'f_tier']);
  });

  it('leaves out an excluded pair and reports it', async () => {
    const { client, sent } = dashboardClient(rankingDashboard(), { 6602: nativeCard(6602, []) });
    const result = await client.setDashboardFilters(621, PARAMS, mapByTag, { exclude: [{ dashcard_id: 2, parameter_id: 'f_tier' }] });
    const card2 = sent().dashcards.find((d: any) => d.id === 2).parameter_mappings;
    expect(card2.map((m: any) => m.parameter_id)).toEqual(['f_mes']);
    expect(result.mappings.find((m: any) => m.dashcard_id === 2).excluded).toEqual(['f_tier']);
  });

  it('refuses a filter whose type cannot feed the variable', async () => {
    const { client, ax } = dashboardClient(rankingDashboard(), { 6602: nativeCard(6602, []) });
    await expect(client.setDashboardFilters(621, PARAMS, { f_tier: 'p_mes' })).rejects.toThrow(
      /filter "f_tier" \(type string\/=\) cannot feed variable \{\{p_mes\}\} of card 6600, which is date; it needs a text variable/,
    );
    expect(ax.put).not.toHaveBeenCalled();
  });

  it('refuses a map_by_tag filter that is not in parameters', async () => {
    const { client } = dashboardClient(rankingDashboard());
    await expect(client.setDashboardFilters(621, PARAMS, { f_nope: 'p_mes' })).rejects.toThrow(/"f_nope", which is not in parameters/);
  });

  it('reports filters that no card uses', async () => {
    const { client } = dashboardClient(rankingDashboard(), { 6602: nativeCard(6602, []) });
    const params = [...PARAMS, { id: 'f_n', name: 'N', slug: 'n', type: 'number/=' }];
    const result = await client.setDashboardFilters(621, params, { ...mapByTag, f_n: 'p_n' });
    expect(result.unmapped_filters).toEqual(['f_n']);
  });

  it('dry_run shows the mappings without writing', async () => {
    const { client, ax } = dashboardClient(rankingDashboard(), { 6602: nativeCard(6602, []) });
    const result = await client.setDashboardFilters(621, PARAMS, mapByTag, { dryRun: true });
    expect(ax.put).not.toHaveBeenCalled();
    expect(result.dry_run).toBe(true);
    expect(result.payload.parameters).toEqual(PARAMS);
    expect(result.mappings).toHaveLength(3);
  });

  it('fetches each card only once', async () => {
    const dash = rankingDashboard();
    dash.dashcards.push({ id: 5, card_id: 6602, row: 9, col: 0, size_x: 6, size_y: 3, parameter_mappings: [] });
    const { client, ax } = dashboardClient(dash, { 6602: nativeCard(6602, [['p_tier', 'text']]) });
    await client.setDashboardFilters(621, PARAMS, mapByTag);
    expect(ax.get.mock.calls.filter(([u]: [string]) => u === '/api/card/6602')).toHaveLength(1);
  });
});

describe('set_dashboard_filters tool', async () => {
  const { addDashboardTools } = await import('../src/tools/dashboard-tools.js');
  const map = new Map<string, any>();
  addDashboardTools({ addTool: (t: any) => map.set(t.name, t) } as any, () => ({}) as any);

  it('is an essential write tool', () => {
    expect(map.get('set_dashboard_filters').metadata).toEqual({ isWrite: true, isEssential: true });
  });
});
