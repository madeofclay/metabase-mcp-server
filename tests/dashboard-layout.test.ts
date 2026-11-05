import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';

// Applies the PUT the way Metabase 0.63 does: negative ids get real ids and
// dashcards pointing at a negative tab follow it (verified on dashboard 621).
function fakeMetabase(initial: any) {
  let state = structuredClone(initial);
  let nextTabId = 500;
  let nextDashcardId = 9000;
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (client as any).axiosInstance;
  ax.get = vi.fn(async (url: string) => {
    if (url === `/api/dashboard/${state.id}`) return { data: structuredClone(state) };
    if (url === `/api/revision/dashboard/${state.id}`) return { data: [{ id: 25803 }] };
    throw new Error(`unexpected GET ${url}`);
  });
  ax.put = vi.fn(async (_url: string, body: any) => {
    const realTab = new Map<number, number>();
    const tabs = (body.tabs ?? state.tabs).map((t: any, position: number) => {
      const id = t.id > 0 ? t.id : nextTabId++;
      if (!(t.id > 0)) realTab.set(t.id, id);
      return { id, name: t.name, position };
    });
    const dashcards = (body.dashcards ?? state.dashcards).map((dc: any) => ({
      ...dc,
      id: dc.id > 0 ? dc.id : nextDashcardId++,
      dashboard_tab_id: realTab.get(dc.dashboard_tab_id) ?? dc.dashboard_tab_id,
    }));
    state = { ...state, ...body, tabs, dashcards };
    return { data: structuredClone(state) };
  });
  return { client, put: ax.put as ReturnType<typeof vi.fn>, state: () => state, sent: () => ax.put.mock.calls[0]?.[1] };
}

const PARAMS = [
  { id: 'f_mes', name: 'Mes', slug: 'mes', type: 'date/month-year', sectionId: 'date' },
  { id: 'f_tier', name: 'Tier', slug: 'tier', type: 'string/=', sectionId: 'string' },
];

// A dashboard without tabs, as the ranking one started.
const flat = () => ({
  id: 621,
  parameters: [],
  tabs: [],
  dashcards: [
    { id: 5666, card_id: 6600, row: 0, col: 0, size_x: 8, size_y: 2, card: { name: 'Mes que estás viendo' }, parameter_mappings: [] },
    { id: 5667, card_id: 6601, row: 2, col: 0, size_x: 6, size_y: 3, card: { name: 'Clientes' }, parameter_mappings: [] },
    { id: 5673, card_id: 6607, row: 5, col: 0, size_x: 24, size_y: 10, card: { name: 'Muy Alta' }, parameter_mappings: [] },
  ],
});

const mapping = (parameter_id: string, card_id: number, tag: string) => ({
  parameter_id, card_id, target: ['variable', ['template-tag', tag]],
});

// The ranking layout: 3 new tabs, headings and text blocks, existing cards moved, one card repeated.
const rankingLayout = () => ({
  tabs: [{ id: -1, name: 'Ranking del mes' }, { id: -2, name: 'Cambios vs mes anterior' }, { id: -3, name: 'Calidad de datos' }],
  parameters: PARAMS,
  width: 'fixed' as const,
  dashcards: [
    { id: -101, dashboard_tab_id: -1, row: 0, col: 0, size_x: 16, size_y: 2, text: '## ¿Quiénes son nuestros clientes más importantes?' },
    { id: 5666, card_id: 6600, dashboard_tab_id: -1, row: 0, col: 16, size_x: 8, size_y: 2, parameter_mappings: [mapping('f_mes', 6600, 'p_mes')] },
    { id: 5667, card_id: 6601, dashboard_tab_id: -1, row: 2, col: 0, size_x: 6, size_y: 3,
      parameter_mappings: [mapping('f_mes', 6601, 'p_mes'), mapping('f_tier', 6601, 'p_tier')],
      visualization_settings: { 'card.hide_empty': true } },
    { id: -102, dashboard_tab_id: -1, row: 5, col: 0, size_x: 24, size_y: 1, text: '#### ¿Quiénes son los clientes Muy Alta?', display: 'heading' as const },
    { id: 5673, card_id: 6607, dashboard_tab_id: -1, row: 6, col: 0, size_x: 24, size_y: 10 },
    { id: -201, dashboard_tab_id: -2, row: 0, col: 0, size_x: 16, size_y: 2, text: '## ¿Qué cambió?' },
    { id: -202, card_id: 6600, dashboard_tab_id: -2, row: 0, col: 16, size_x: 8, size_y: 2 },
    { id: -301, dashboard_tab_id: -3, row: 0, col: 0, size_x: 24, size_y: 2,
      card_id: null, visualization_settings: { virtual_card: { display: 'text' }, text: '## ¿Qué datos hay que corregir?' } },
  ],
});

describe('putDashboardLayout', () => {
  it('turns a dashboard without tabs into 3 tabs with texts and cards in one PUT', async () => {
    const mb = fakeMetabase(flat());
    const result = await mb.client.putDashboardLayout(621, rankingLayout());

    expect(mb.put).toHaveBeenCalledTimes(1);
    const sent = mb.sent();
    expect(sent.tabs).toEqual([
      { id: -1, name: 'Ranking del mes' }, { id: -2, name: 'Cambios vs mes anterior' }, { id: -3, name: 'Calidad de datos' },
    ]);
    expect(sent.parameters).toEqual(PARAMS);
    expect(sent.width).toBe('fixed');
    expect(sent.dashcards).toHaveLength(8);

    // The shorthand becomes a virtual card, as the ranking script built them.
    const heading = sent.dashcards.find((d: any) => d.id === -102);
    expect(heading.card_id).toBeNull();
    expect(heading.visualization_settings).toEqual({
      'dashcard.background': false, virtual_card: { display: 'heading' }, text: '#### ¿Quiénes son los clientes Muy Alta?',
    });
    expect(heading).not.toHaveProperty('text');
    expect(heading).not.toHaveProperty('display');
    expect(sent.dashcards.find((d: any) => d.id === -101).visualization_settings['dashcard.background']).toBe(true);

    expect(result.tabs.map((t: any) => t.name)).toEqual(['Ranking del mes', 'Cambios vs mes anterior', 'Calidad de datos']);
    expect(result.tabs.every((t: any) => t.id > 0)).toBe(true);
    expect(result.dashcards).toBe(8);
    expect(result.diff.dashcards).toEqual({ added: 5, kept: 3, removed: [] });
    expect(result.previous_revision_id).toBe(25803);
    expect(mb.state().dashcards.every((d: any) => d.dashboard_tab_id > 0)).toBe(true);
  });

  it('refuses a card that runs past the 24-column grid', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards[1] = { ...layout.dashcards[1], col: 18, size_x: 8 };
    await expect(mb.client.putDashboardLayout(621, layout)).rejects.toThrow(/dashcard 5666: col \+ size_x = 26/);
    expect(mb.put).not.toHaveBeenCalled();
  });

  it('refuses a mapping to a filter that does not exist', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards[1] = { ...layout.dashcards[1], parameter_mappings: [mapping('f_nicho', 6600, 'p_nicho')] };
    await expect(mb.client.putDashboardLayout(621, layout)).rejects.toThrow(/maps filter "f_nicho"/);
    expect(mb.put).not.toHaveBeenCalled();
  });

  it('checks mappings against the current filters when none are given', async () => {
    const mb = fakeMetabase({ ...flat(), parameters: PARAMS });
    const { parameters, ...layout } = rankingLayout();
    await mb.client.putDashboardLayout(621, layout);
    expect(mb.sent()).not.toHaveProperty('parameters');
  });

  it('refuses a mapping whose card_id is not the card shown', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards[1] = { ...layout.dashcards[1], parameter_mappings: [mapping('f_mes', 9999, 'p_mes')] };
    await expect(mb.client.putDashboardLayout(621, layout)).rejects.toThrow(/has card_id 9999, but the dashcard shows card 6600/);
  });

  it('collects every problem in one error', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards.push(
      { id: -101, dashboard_tab_id: -1, row: 0, col: 0, size_x: 1, size_y: 1, text: 'dup' },
      { id: -900, dashboard_tab_id: -9, row: -1, col: 0, size_x: 0, size_y: 1, card_id: 5 } as any,
      { id: 4444, card_id: 1, dashboard_tab_id: -1, row: 0, col: 0, size_x: 1, size_y: 1 } as any,
      { id: -901, dashboard_tab_id: -1, row: 0, col: 0, size_x: 2, size_y: 2, card_id: null } as any,
    );
    const err = await mb.client.putDashboardLayout(621, layout).catch((e: Error) => e.message);
    expect(err).toMatch(/dashcard -101: id appears twice/);
    expect(err).toMatch(/dashcard -900: row and col must be >= 0/);
    expect(err).toMatch(/dashcard -900: size_x and size_y must be >= 1/);
    expect(err).toMatch(/dashcard -900: tab -9 is not in the layout/);
    expect(err).toMatch(/dashcard 4444: not on the dashboard/);
    expect(err).toMatch(/dashcard -901: a card without card_id needs visualization_settings.virtual_card.display/);
  });

  it('refuses a dashcard without tab when the layout has tabs', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    const { dashboard_tab_id, ...noTab } = layout.dashcards[4] as any;
    layout.dashcards[4] = noTab;
    await expect(mb.client.putDashboardLayout(621, layout)).rejects.toThrow(/dashcard 5673: needs dashboard_tab_id/);
  });

  it('lists what it would delete and asks for confirm_removals', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards = layout.dashcards.filter((d) => d.id !== 5673);
    await expect(mb.client.putDashboardLayout(621, layout)).rejects.toThrow(
      /deletes 1 item\(s\) from dashboard 621: dashcard 5673 \(Muy Alta\).*confirm_removals: true/,
    );
    expect(mb.put).not.toHaveBeenCalled();

    const result = await mb.client.putDashboardLayout(621, layout, { confirmRemovals: true });
    expect(result.removals.dashcards).toEqual([{ id: 5673, card_id: 6607, name: 'Muy Alta', tab: null }]);
    expect(result.diff.dashcards.removed).toEqual([5673]);
  });

  it('asks for confirm_removals when a current tab is left out', async () => {
    const mb = fakeMetabase({
      id: 3, parameters: [], tabs: [{ id: 10, name: 'A', position: 0 }, { id: 11, name: 'B', position: 1 }],
      dashcards: [{ id: 1, card_id: 2, dashboard_tab_id: 10, row: 0, col: 0, size_x: 4, size_y: 4 }],
    });
    const layout = { tabs: [{ id: 10, name: 'A' }], dashcards: [{ id: 1, card_id: 2, dashboard_tab_id: 10, row: 0, col: 0, size_x: 4, size_y: 4 }] };
    await expect(mb.client.putDashboardLayout(3, layout)).rejects.toThrow(/tab 11 \(B\)/);
  });

  it('keeps the current tabs when the layout gives none', async () => {
    const mb = fakeMetabase({
      id: 3, parameters: [], tabs: [{ id: 10, name: 'A', position: 0 }],
      dashcards: [{ id: 1, card_id: 2, dashboard_tab_id: 10, row: 0, col: 0, size_x: 4, size_y: 4 }],
    });
    await mb.client.putDashboardLayout(3, { dashcards: [{ id: 1, card_id: 2, dashboard_tab_id: 10, row: 3, col: 0, size_x: 4, size_y: 4 }] });
    expect(mb.sent().tabs).toEqual([{ id: 10, name: 'A' }]);
  });

  it('dry_run shows the diff, the removals and the payload without writing', async () => {
    const mb = fakeMetabase(flat());
    const layout = rankingLayout();
    layout.dashcards = layout.dashcards.filter((d) => d.id !== 5673);
    const result = await mb.client.putDashboardLayout(621, layout, { dryRun: true });
    expect(mb.put).not.toHaveBeenCalled();
    expect(result.dry_run).toBe(true);
    expect(result.needs_confirm_removals).toBe(true);
    expect(result.removals.dashcards.map((d: any) => d.id)).toEqual([5673]);
    expect(result.diff.dashcards).toEqual({ added: 5, kept: 2, removed: [5673] });
    expect(result.payload.dashcards).toHaveLength(7);
    expect(result.tabs).toEqual(rankingLayout().tabs);
  });
});

describe('put_dashboard_layout tool', async () => {
  const { addDashboardTools } = await import('../src/tools/dashboard-tools.js');
  const tools = new Map<string, any>();
  const mb = fakeMetabase(flat());
  addDashboardTools({ addTool: (t: any) => tools.set(t.name, t) } as any, () => mb.client as any);
  const tool = tools.get('put_dashboard_layout');

  it('is an essential write tool', () => {
    expect(tool.metadata).toEqual({ isWrite: true, isEssential: true });
  });

  it('accepts the ranking layout, text shorthand included', () => {
    expect(tool.parameters.safeParse({ dashboard_id: 621, ...rankingLayout(), dry_run: true }).success).toBe(true);
  });

  it('passes dry_run and confirm_removals through', async () => {
    const out = JSON.parse(await tool.execute({ dashboard_id: 621, ...rankingLayout(), dry_run: true }, {}));
    expect(out.dry_run).toBe(true);
    expect(mb.put).not.toHaveBeenCalled();
  });
});
