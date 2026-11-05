import { describe, it, expect } from 'vitest';
import { compactResult, dashboardSummary } from '../src/utils/compact-result.js';
import { describeResource, explainMetabaseError, metabaseDetail } from '../src/utils/metabase-errors.js';
import { addDashboardTools } from '../src/tools/dashboard-tools.js';

/** A dashboard shaped like Metabase's PUT response, with heavy embedded cards. */
function bigDashboard() {
  const heavy = { name: 'Clientes', dataset_query: { native: 'x'.repeat(5000) }, result_metadata: Array(30).fill({ a: 1 }) };
  return {
    id: 623, name: 'Ranking', collection_id: 548, width: 'fixed',
    tabs: [{ id: 2, name: 'B', position: 1 }, { id: 1, name: 'A', position: 0 }],
    parameters: [{ id: 'f_mes', name: 'Mes', type: 'date/month-year', slug: 'mes' }],
    dashcards: [
      { id: 10, card_id: 5, dashboard_tab_id: 1, row: 0, col: 0, size_x: 6, size_y: 3, card: heavy,
        parameter_mappings: [{ parameter_id: 'f_mes', card_id: 5, target: [] }],
        visualization_settings: { 'card.hide_empty': true } },
      { id: 11, card_id: null, dashboard_tab_id: 2, row: 0, col: 0, size_x: 24, size_y: 1, card: null,
        parameter_mappings: [], visualization_settings: { text: '#### ' + 'y'.repeat(100), virtual_card: { display: 'heading' } } },
    ],
  };
}

describe('compactResult', () => {
  it('reduces a dashboard write to a summary', () => {
    const full = { dashboard: bigDashboard(), previous_revision_id: 99, diff: { dashcards: { added: 1, kept: 1, removed: [] } } };
    const out = compactResult(full);
    expect(out.previous_revision_id).toBe(99);
    expect(out.diff).toEqual(full.diff);
    expect(out.dashboard).toEqual({
      id: 623, name: 'Ranking', collection_id: 548, width: 'fixed',
      tabs: [{ id: 1, name: 'A', cards: 1 }, { id: 2, name: 'B', cards: 1 }],
      dashcards: 2,
      filters: [{ id: 'f_mes', name: 'Mes', type: 'date/month-year' }],
      mappings: 1,
    });
    expect(out.note).toMatch(/include_dashboard/);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(full).length / 10);
  });

  it('summarizes a dry-run payload card by card', () => {
    const d = bigDashboard();
    const out = compactResult({ dashboard: null, previous_revision_id: null, diff: {}, dry_run: true,
      payload: { tabs: d.tabs, dashcards: d.dashcards, width: 'fixed' } });
    expect(out.payload.width).toBe('fixed');
    expect(out.payload.dashcards[0]).toEqual({ id: 10, card_id: 5, tab: 1, at: 'r0 c0 6x3', name: 'Clientes', filters: ['f_mes'], hide_empty: true });
    expect(out.payload.dashcards[1].text.endsWith('…')).toBe(true);
    expect(out.payload.dashcards[1].text.length).toBeLessThanOrEqual(61);
  });

  it('shortens set_dashboard_filters mappings to one line per card', () => {
    const out = compactResult({ dashboard: null, previous_revision_id: 1, diff: {}, mappings: [
      { dashcard_id: 10, card_id: 5, mapped: [{ parameter_id: 'f_mes', tag: 'p_mes' }], not_applicable: ['f_tier'], excluded: [] },
    ] });
    expect(out.mappings).toEqual([{ dashcard_id: 10, card_id: 5, mapped: ['f_mes→p_mes'], not_applicable: ['f_tier'] }]);
  });

  it('keeps everything with includeDashboard, and leaves other results alone', () => {
    const full = { dashboard: bigDashboard(), previous_revision_id: 1, diff: {} };
    expect(compactResult(full, true)).toBe(full);
    const other = { id: 1, dashcards: [1, 2] };
    expect(compactResult(other)).toBe(other);
  });

  it('dashboardSummary tolerates a missing dashboard', () => {
    expect(dashboardSummary(null)).toBeNull();
  });
});

describe('dashboard tools return the summary', () => {
  it('put_dashboard_layout answers compactly unless include_dashboard is set', async () => {
    const client: any = {
      putDashboardLayout: async () => ({ dashboard: bigDashboard(), previous_revision_id: 7, diff: {}, tabs: [], dashcards: 2 }),
    };
    const tools: Record<string, any> = {};
    addDashboardTools({ addTool: (t: any) => { tools[t.name] = t; } }, () => client);
    const short = JSON.parse(await tools.put_dashboard_layout.execute({ dashboard_id: 623, dashcards: [] }, {}));
    expect(short.dashboard.tabs).toHaveLength(2);
    expect(short.dashboard.dashcards).toBe(2);
    const full = JSON.parse(await tools.put_dashboard_layout.execute({ dashboard_id: 623, dashcards: [], include_dashboard: true }, {}));
    expect(full.dashboard.dashcards).toHaveLength(2);
  });

  it('does not forward include_dashboard to Metabase', async () => {
    let seen: any;
    const client: any = { putDashboardLayout: async (_id: number, layout: any) => { seen = layout; return { diff: {}, previous_revision_id: 1 }; } };
    const tools: Record<string, any> = {};
    addDashboardTools({ addTool: (t: any) => { tools[t.name] = t; } }, () => client);
    await tools.put_dashboard_layout.execute({ dashboard_id: 1, dashcards: [], include_dashboard: true, dry_run: true }, {});
    expect(seen).not.toHaveProperty('include_dashboard');
  });
});

describe('explicit Metabase errors', () => {
  it('names the resource from the request path', () => {
    expect(describeResource('get', '/api/card/6537')).toBe('card 6537');
    expect(describeResource('put', '/api/dashboard/621?x=1')).toBe('dashboard 621');
    expect(describeResource('get', '/api/database/40/metadata')).toBe('database 40');
    expect(describeResource('post', '/api/dataset', JSON.stringify({ database: 40 }))).toBe('a query on database 40');
    expect(describeResource('post', '/api/dataset', { type: 'native' })).toBe('a query');
    expect(describeResource('get', '/api/collection')).toBe('collections');
  });

  it('reads Metabase\'s own explanation', () => {
    expect(metabaseDetail("You don't have permissions to do that.")).toBe("You don't have permissions to do that.");
    expect(metabaseDetail({ message: 'Not allowed' })).toBe('Not allowed');
    expect(metabaseDetail(undefined)).toBeUndefined();
  });

  it('explains a 403 with the resource, the user and what to do', () => {
    const m = explainMetabaseError({ status: 403, method: 'post', url: '/api/card/6537/query',
      responseData: "You don't have permissions to do that.", user: 'ana@clay.cl' });
    expect(m).toContain('denied access (403) to card 6537');
    expect(m).toContain('ana@clay.cl');
    expect(m).toContain("You don't have permissions to do that.");
    expect(m).toContain('Ask a Metabase administrator for access to that card 6537');
  });

  it('explains a 401 as an expired session to reconnect', () => {
    const m = explainMetabaseError({ status: 401, method: 'get', url: '/api/dashboard/621' });
    expect(m).toContain('401');
    expect(m).toContain('dashboard 621');
    expect(m).toMatch(/Reconnect the Metabase MCP/);
  });

  it('leaves other statuses alone', () => {
    expect(explainMetabaseError({ status: 500, url: '/api/card/1' })).toBeUndefined();
  });
});

import { AxiosError } from 'axios';
import { MetabaseClient } from '../src/client/metabase-client.js';

/** A client whose HTTP layer answers from `routes` instead of the network. */
function clientAnswering(routes: Record<string, { status: number; data: any }>) {
  const client = new MetabaseClient({ url: 'http://metabase.test', apiKey: 'k' });
  const calls: string[] = [];
  (client as any).axiosInstance.defaults.adapter = async (config: any) => {
    calls.push(config.url);
    const r = routes[config.url] ?? { status: 404, data: 'Not found' };
    const response = { status: r.status, statusText: '', data: r.data, headers: {}, config };
    if (r.status >= 400) {
      throw new AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_REQUEST', config, null, response as any);
    }
    return response;
  };
  return { client, calls };
}

describe('MetabaseClient errors as the tools see them', () => {
  it('a 403 names the card, the user and what Metabase said', async () => {
    const { client } = clientAnswering({
      '/api/card/6537': { status: 403, data: "You don't have permissions to do that." },
      '/api/user/current': { status: 200, data: { email: 'ana@clay.cl' } },
    });
    await expect(client.getCard(6537)).rejects.toThrow(
      /denied access \(403\) to card 6537: the signed-in user \(ana@clay\.cl\) has no permission on it\. Metabase said: "You don't have permissions to do that\."/
    );
  });

  it('looks the user up once per client', async () => {
    const { client, calls } = clientAnswering({
      '/api/card/1': { status: 403, data: '' },
      '/api/card/2': { status: 403, data: '' },
      '/api/user/current': { status: 200, data: { email: 'ana@clay.cl' } },
    });
    await expect(client.getCard(1)).rejects.toThrow(/ana@clay\.cl/);
    await expect(client.getCard(2)).rejects.toThrow(/ana@clay\.cl/);
    expect(calls.filter((u) => u === '/api/user/current')).toHaveLength(1);
  });

  it('a 403 still explains itself when the user cannot be read', async () => {
    const { client } = clientAnswering({
      '/api/card/9': { status: 403, data: '' },
      '/api/user/current': { status: 403, data: '' },
    });
    await expect(client.getCard(9)).rejects.toThrow(/denied access \(403\) to card 9: the signed-in user has no permission/);
  });

  it('a 401 asks to reconnect', async () => {
    const { client } = clientAnswering({ '/api/dashboard/621': { status: 401, data: 'Unauthenticated' } });
    await expect(client.getDashboard(621)).rejects.toThrow(/401.*dashboard 621.*Reconnect the Metabase MCP/);
  });

  it('other errors keep axios\' message', async () => {
    const { client } = clientAnswering({ '/api/card/5': { status: 500, data: 'boom' } });
    await expect(client.getCard(5)).rejects.toThrow('Request failed with status code 500');
  });
});
