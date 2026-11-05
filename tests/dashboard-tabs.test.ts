import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';

// A fake Metabase that applies the PUT the way 0.63 does: negative tab ids get
// real ids, and dashcards pointing at a negative id follow their new tab.
function fakeMetabase(initial: any) {
  let state = structuredClone(initial);
  let nextTabId = 500;
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (client as any).axiosInstance;
  ax.get = vi.fn(async (url: string) => {
    if (url === `/api/dashboard/${state.id}`) return { data: structuredClone(state) };
    if (url === `/api/revision/dashboard/${state.id}`) return { data: [{ id: 77 }] };
    throw new Error(`unexpected GET ${url}`);
  });
  ax.put = vi.fn(async (_url: string, body: any) => {
    const realId = new Map<number, number>();
    const tabs = (body.tabs || []).map((t: any, position: number) => {
      const id = t.id > 0 ? t.id : nextTabId++;
      if (t.id <= 0) realId.set(t.id, id);
      return { id, name: t.name, position };
    });
    const dashcards = (body.dashcards || state.dashcards).map((dc: any) => ({
      ...dc,
      dashboard_tab_id: realId.get(dc.dashboard_tab_id) ?? dc.dashboard_tab_id,
    }));
    state = { ...state, tabs, dashcards };
    return { data: structuredClone(state) };
  });
  return { client, put: ax.put as ReturnType<typeof vi.fn>, state: () => state };
}

const card = (id: number, tab: number | null) => ({
  id, card_id: id * 10, dashboard_tab_id: tab, row: 0, col: 0, size_x: 6, size_y: 4,
  card: { id: id * 10 }, series: [], parameter_mappings: [], visualization_settings: {},
});

const withoutTabs = () => ({ id: 1, tabs: [], dashcards: [card(1, null), card(2, null)] });
const withTabs = () => ({
  id: 2,
  tabs: [
    { id: 10, name: 'Resumen', position: 0 },
    { id: 11, name: 'Detalle', position: 1 },
    { id: 12, name: 'Viejo', position: 2 },
  ],
  dashcards: [card(1, 10), card(2, 11), card(3, 12), card(4, 12)],
});

describe('manageDashboardTabs', () => {
  it('creates tabs on a dashboard without them, moving every card to the first', async () => {
    const mb = fakeMetabase(withoutTabs());
    const result = await mb.client.manageDashboardTabs(1, [{ name: 'Resumen' }, { name: 'Detalle' }]);
    const sent = mb.put.mock.calls[0][1];
    expect(sent.tabs).toEqual([{ id: -1, name: 'Resumen' }, { id: -2, name: 'Detalle' }]);
    expect(sent.dashcards.every((dc: any) => dc.dashboard_tab_id === -1)).toBe(true);
    // Real ids, read back after the write.
    expect(result.tabs).toEqual([
      { id: 500, name: 'Resumen', position: 0 },
      { id: 501, name: 'Detalle', position: 1 },
    ]);
    expect(mb.state().dashcards.every((dc: any) => dc.dashboard_tab_id === 500)).toBe(true);
    expect(result.moved_cards).toEqual([{ from_tab: null, to_tab: { id: -1, name: 'Resumen' }, cards: 2 }]);
    expect(result.previous_revision_id).toBe(77);
  });

  it('renames a tab without touching cards', async () => {
    const mb = fakeMetabase(withTabs());
    await mb.client.manageDashboardTabs(2, [
      { id: 10, name: 'Resumen general' }, { id: 11, name: 'Detalle' }, { id: 12, name: 'Viejo' },
    ]);
    const sent = mb.put.mock.calls[0][1];
    expect(sent.tabs[0]).toEqual({ id: 10, name: 'Resumen general' });
    expect(sent.dashcards.map((dc: any) => dc.dashboard_tab_id)).toEqual([10, 11, 12, 12]);
  });

  it('reorders tabs by their position in the list', async () => {
    const mb = fakeMetabase(withTabs());
    const result = await mb.client.manageDashboardTabs(2, [
      { id: 12, name: 'Viejo' }, { id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' },
    ]);
    expect(result.tabs.map((t: any) => t.id)).toEqual([12, 10, 11]);
  });

  it('refuses to delete a tab with cards when no destination is given', async () => {
    const mb = fakeMetabase(withTabs());
    await expect(
      mb.client.manageDashboardTabs(2, [{ id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' }]),
    ).rejects.toThrow(/"Viejo" \(12\) has 2 cards/);
    expect(mb.put).not.toHaveBeenCalled();
  });

  it('deletes a tab with cards, moving them to an existing tab', async () => {
    const mb = fakeMetabase(withTabs());
    const result = await mb.client.manageDashboardTabs(
      2, [{ id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' }], { moveCardsFromDeletedTo: 11 },
    );
    expect(mb.state().dashcards.map((dc: any) => dc.dashboard_tab_id)).toEqual([10, 11, 11, 11]);
    expect(result.deleted_tabs).toEqual([{ id: 12, name: 'Viejo' }]);
    expect(result.diff.dashcards.removed).toEqual([]);
    expect(result.diff.tabs.removed).toEqual([12]);
  });

  it('moves the cards of a deleted tab to a new tab, given by position', async () => {
    const mb = fakeMetabase(withTabs());
    await mb.client.manageDashboardTabs(
      2, [{ id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' }, { name: 'Archivo' }], { moveCardsFromDeletedTo: 2 },
    );
    const sent = mb.put.mock.calls[0][1];
    expect(sent.dashcards.filter((dc: any) => dc.dashboard_tab_id === -1)).toHaveLength(2);
    expect(mb.state().dashcards.map((dc: any) => dc.dashboard_tab_id)).toEqual([10, 11, 500, 500]);
  });

  it('deletes an empty tab without asking for a destination', async () => {
    const mb = fakeMetabase({ ...withTabs(), dashcards: [card(1, 10), card(2, 11)] });
    await mb.client.manageDashboardTabs(2, [{ id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' }]);
    expect(mb.state().tabs.map((t: any) => t.id)).toEqual([10, 11]);
  });

  it('refuses a destination that is not in the new list', async () => {
    const mb = fakeMetabase(withTabs());
    await expect(
      mb.client.manageDashboardTabs(2, [{ id: 10, name: 'Resumen' }], { moveCardsFromDeletedTo: 12 }),
    ).rejects.toThrow(/move_cards_from_deleted_to=12/);
  });

  it('asks for confirm before removing every tab', async () => {
    const mb = fakeMetabase(withTabs());
    await expect(mb.client.manageDashboardTabs(2, [])).rejects.toThrow(/confirm: true/);
    expect(mb.put).not.toHaveBeenCalled();

    await mb.client.manageDashboardTabs(2, [], { confirm: true });
    const sent = mb.put.mock.calls[0][1];
    expect(sent.tabs).toEqual([]);
    expect(sent.dashcards).toHaveLength(4);
    expect(sent.dashcards.every((dc: any) => dc.dashboard_tab_id === null)).toBe(true);
  });

  it('refuses an existing id that is not in the dashboard, or repeated', async () => {
    const mb = fakeMetabase(withTabs());
    await expect(mb.client.manageDashboardTabs(2, [{ id: 99, name: 'X' }])).rejects.toThrow(/Tab 99 is not in dashboard/);
    await expect(
      mb.client.manageDashboardTabs(2, [{ id: 10, name: 'A' }, { id: 10, name: 'B' }]),
    ).rejects.toThrow(/appears twice/);
  });

  it('previews with dry_run without writing', async () => {
    const mb = fakeMetabase(withoutTabs());
    const result = await mb.client.manageDashboardTabs(1, [{ name: 'Resumen' }], { dryRun: true });
    expect(mb.put).not.toHaveBeenCalled();
    expect(result.dry_run).toBe(true);
    expect(result.tabs).toEqual([{ id: -1, name: 'Resumen' }]);
    expect(result.diff.tabs).toEqual({ added: 1, kept: 0, removed: [] });
    expect(result.payload.dashcards.every((dc: any) => dc.dashboard_tab_id === -1)).toBe(true);
  });
});

describe('manage_dashboard_tabs tool', async () => {
  const { addDashboardTools } = await import('../src/tools/dashboard-tools.js');
  const tools = new Map<string, any>();
  const mb = fakeMetabase(withoutTabs());
  addDashboardTools({ addTool: (t: any) => tools.set(t.name, t) } as any, () => mb.client as any);
  const tool = tools.get('manage_dashboard_tabs');

  it('is an essential write tool', () => {
    expect(tool.metadata).toEqual({ isWrite: true, isEssential: true });
  });

  it('passes the options through to the client', async () => {
    const out = JSON.parse(await tool.execute({ dashboard_id: 1, tabs: [{ name: 'A' }], dry_run: true }, {}));
    expect(out.dry_run).toBe(true);
    expect(mb.put).not.toHaveBeenCalled();
  });
});
