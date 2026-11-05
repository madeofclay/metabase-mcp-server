import { describe, it, expect, vi } from 'vitest';
import { MetabaseClient } from '../src/client/metabase-client.js';

// A dashboard as GET /api/dashboard/:id returns it: dashcards carry a nested
// `card` and read-only fields the PUT must not receive.
function dashboardWithTabs() {
  return {
    id: 7,
    name: 'Ranking',
    tabs: [
      { id: 10, name: 'Resumen', position: 0, dashboard_id: 7, created_at: 'x' },
      { id: 11, name: 'Detalle', position: 1, dashboard_id: 7, created_at: 'x' },
    ],
    dashcards: [
      {
        id: 100, card_id: 5, dashboard_tab_id: 10, row: 0, col: 0, size_x: 12, size_y: 6,
        series: [], parameter_mappings: [], visualization_settings: {},
        inline_parameters: ['p1'], action_id: null,
        card: { id: 5, name: 'Nested card' }, created_at: 'x', updated_at: 'y', dashboard_id: 7,
      },
      {
        id: 101, card_id: null, dashboard_tab_id: 11, row: 0, col: 0, size_x: 24, size_y: 1,
        series: [], parameter_mappings: [],
        visualization_settings: { virtual_card: { display: 'heading' }, text: 'Título' },
        card: { name: null }, dashboard_id: 7,
      },
    ],
  };
}

function mockClient(dashboard: any = dashboardWithTabs(), revisions: any = [{ id: 40 }, { id: 42 }, { id: 41 }]) {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
  const ax = (client as any).axiosInstance;
  const get = vi.fn(async (url: string) => {
    if (url === `/api/dashboard/${dashboard.id}`) return { data: structuredClone(dashboard) };
    if (url === `/api/revision/dashboard/${dashboard.id}`) {
      if (revisions instanceof Error) throw revisions;
      return { data: revisions };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  const put = vi.fn(async (_url: string, body: any) => ({ data: { id: dashboard.id, ...body } }));
  ax.get = get;
  ax.put = put;
  return { client, get, put, body: () => put.mock.calls[0]?.[1] };
}

describe('putDashboardSafe', () => {
  it('keeps the stored tabs when the dashcards come without them', async () => {
    const { client, body } = mockClient();
    await client.updateDashboardCards(7, dashboardWithTabs().dashcards);
    expect(body().tabs).toEqual([{ id: 10, name: 'Resumen' }, { id: 11, name: 'Detalle' }]);
  });

  it('sends only the fields the PUT accepts, without the nested card', async () => {
    const { client, body } = mockClient();
    await client.updateDashboardCards(7, dashboardWithTabs().dashcards);
    const [first, heading] = body().dashcards;
    expect(first).not.toHaveProperty('card');
    expect(first).not.toHaveProperty('created_at');
    expect(first).not.toHaveProperty('dashboard_id');
    expect(first.inline_parameters).toEqual(['p1']);
    expect(heading.card_id).toBeNull();
    expect(body()).not.toHaveProperty('name'); // no raw `...dashboard`
  });

  it('refuses a dashcard without dashboard_tab_id when the dashboard has tabs', async () => {
    const { client, put } = mockClient();
    await expect(
      client.updateDashboardCards(7, [{ id: 100, card_id: 5, row: 0, col: 0, size_x: 12, size_y: 6 }]),
    ).rejects.toThrow(/needs dashboard_tab_id.*Tabs: 10 \(Resumen\), 11 \(Detalle\)/);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a dashcard pointing at a tab that does not exist', async () => {
    const { client, put } = mockClient();
    await expect(
      client.updateDashboardCards(7, [{ id: 100, card_id: 5, dashboard_tab_id: 99 }]),
    ).rejects.toThrow(/tab 99/);
    expect(put).not.toHaveBeenCalled();
  });

  it('returns the revision from before the write, to undo it', async () => {
    const { client } = mockClient();
    const result = await client.updateDashboardCards(7, dashboardWithTabs().dashcards);
    expect(result.previous_revision_id).toBe(42);
  });

  it('still writes when the revisions cannot be read, saying so', async () => {
    const { client, put } = mockClient(dashboardWithTabs(), new Error('403'));
    const result = await client.updateDashboardCards(7, dashboardWithTabs().dashcards);
    expect(put).toHaveBeenCalled();
    expect(result.previous_revision_id).toBeNull();
  });

  it('summarizes what the write changes', async () => {
    const { client } = mockClient();
    const result = await client.updateDashboardCards(7, [
      dashboardWithTabs().dashcards[0],
      { id: -1, card_id: 9, dashboard_tab_id: 11 },
    ]);
    expect(result.diff.dashcards).toEqual({ added: 1, kept: 1, removed: [101] });
    expect(result.diff.tabs).toEqual({ added: 0, kept: 2, removed: [] });
  });

  it('does not send tabs or dashcards for a metadata-only write', async () => {
    const { client, body } = mockClient();
    await client.putDashboardSafe(7, { name: 'Nuevo nombre' });
    expect(body()).toEqual({ name: 'Nuevo nombre' });
  });

  it('works on a dashboard without tabs', async () => {
    const plain = { id: 8, tabs: [], dashcards: [{ id: 1, card_id: 2, row: 0, col: 0, size_x: 4, size_y: 4 }] };
    const { client, body } = mockClient(plain);
    await client.updateDashboardCards(8, [{ id: 1, card_id: 2, row: 1 }]);
    expect(body().tabs).toEqual([]);
    expect(body().dashcards[0].dashboard_tab_id).toBeUndefined();
  });
});

describe('dashcard operations', () => {
  it('addCardToDashboard keeps every existing dashcard and the tabs', async () => {
    const { client, body } = mockClient();
    await client.addCardToDashboard(7, { card_id: 9, dashboard_tab_id: 11, inline_parameters: ['p2'], action_id: 3 });
    const sent = body();
    expect(sent.dashcards.map((d: any) => d.id)).toEqual([100, 101, -1]);
    expect(sent.dashcards[0].inline_parameters).toEqual(['p1']);
    expect(sent.dashcards[2]).toMatchObject({ card_id: 9, dashboard_tab_id: 11, inline_parameters: ['p2'], action_id: 3 });
    expect(sent.tabs).toHaveLength(2);
  });

  it('addCardToDashboard asks for a tab on a dashboard with tabs', async () => {
    const { client } = mockClient();
    await expect(client.addCardToDashboard(7, { card_id: 9 })).rejects.toThrow(/dashboard_tab_id/);
  });

  it('updateDashcard changes one dashcard and leaves the rest and the tabs alone', async () => {
    const { client, body } = mockClient();
    await client.updateDashcard(7, 100, { size_x: 24, card: { junk: true } });
    const sent = body();
    expect(sent.dashcards[0]).toMatchObject({ id: 100, size_x: 24, dashboard_tab_id: 10 });
    expect(sent.dashcards[0]).not.toHaveProperty('card');
    expect(sent.dashcards[1].id).toBe(101);
    expect(sent.tabs).toHaveLength(2);
  });

  it('updateDashcard cannot change the id, which would delete the dashcard', async () => {
    const { client, body } = mockClient();
    await client.updateDashcard(7, 100, { id: 555 });
    expect(body().dashcards.map((d: any) => d.id)).toEqual([100, 101]);
  });

  it('removeCardsFromDashboard removes only those dashcards and keeps the tabs', async () => {
    const { client, body } = mockClient();
    const result = await client.removeCardsFromDashboard(7, [101]);
    expect(body().dashcards.map((d: any) => d.id)).toEqual([100]);
    expect(body().tabs).toHaveLength(2);
    expect(result.diff.dashcards.removed).toEqual([101]);
  });

  it('removeCardsFromDashboard refuses an id that is not on the dashboard', async () => {
    const { client, put } = mockClient();
    await expect(client.removeCardsFromDashboard(7, [999])).rejects.toThrow(/999/);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('revisions', () => {
  it('reverts through /api/revision/revert', async () => {
    const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'test-key' });
    const post = vi.fn(async () => ({ data: {} }));
    (client as any).axiosInstance.post = post;
    await client.revertDashboard(7, 42);
    expect(post).toHaveBeenCalledWith('/api/revision/revert', { entity: 'dashboard', id: 7, revision_id: 42 });
  });
});

describe('essential dashboard tools', async () => {
  const { addDashboardTools } = await import('../src/tools/dashboard-tools.js');
  const tools = new Map<string, any>();
  addDashboardTools({ addTool: (t: any) => tools.set(t.name, t) } as any, () => ({}) as any);

  it.each(['add_text_block', 'update_dashboard', 'update_dashcard', 'revert_dashboard', 'get_dashboard_revisions'])(
    '%s loads in the default essential mode',
    (name) => {
      expect(tools.get(name)?.metadata?.isEssential).toBe(true);
    },
  );
});
