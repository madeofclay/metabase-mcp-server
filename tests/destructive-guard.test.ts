import { describe, it, expect, afterEach } from 'vitest';
import { addDashboardTools } from '../src/tools/dashboard-tools.js';
import { setDestructiveAllowed } from '../src/utils/tool-filters.js';

/** The guarded tools, wired to a fake client that records each call. */
function guarded(preview: { layoutRemovals?: any; deletedTabs?: any[] }) {
  const calls: { method: string; dryRun?: boolean }[] = [];
  const client: any = {
    putDashboardLayout: async (_id: number, _layout: any, o: any = {}) => {
      calls.push({ method: 'putDashboardLayout', dryRun: o.dryRun });
      return { removals: preview.layoutRemovals ?? { dashcards: [], tabs: [] } };
    },
    manageDashboardTabs: async (_id: number, _tabs: any, o: any = {}) => {
      calls.push({ method: 'manageDashboardTabs', dryRun: o.dryRun });
      return { deleted_tabs: preview.deletedTabs ?? [] };
    },
  };
  const tools: Record<string, any> = {};
  addDashboardTools({ addTool: (t: any) => { tools[t.name] = t; } }, () => client);
  return { tools, calls };
}

const layout = { dashboard_id: 1, dashcards: [] };
const tabs = { dashboard_id: 1, tabs: [{ id: 10, name: 'A' }] };

describe('guarded layout tools without destructive tools', () => {
  afterEach(() => setDestructiveAllowed(true));

  it('put_dashboard_layout refuses a layout that drops a dashcard, without writing', async () => {
    setDestructiveAllowed(false);
    const { tools, calls } = guarded({ layoutRemovals: { dashcards: [{ id: 7, name: 'Ventas' }], tabs: [] } });
    await expect(tools.put_dashboard_layout.execute({ ...layout, confirm_removals: true }, {}))
      .rejects.toThrow(/Deleting dashcard 7 \(Ventas\) is disabled/);
    expect(calls).toEqual([{ method: 'putDashboardLayout', dryRun: true }]);
  });

  it('put_dashboard_layout writes a layout that only adds or moves', async () => {
    setDestructiveAllowed(false);
    const { tools, calls } = guarded({});
    await tools.put_dashboard_layout.execute(layout, {});
    expect(calls.map((c) => c.dryRun)).toEqual([true, undefined]);
  });

  it('manage_dashboard_tabs refuses to delete a tab, without writing', async () => {
    setDestructiveAllowed(false);
    const { tools, calls } = guarded({ deletedTabs: [{ id: 11, name: 'B' }] });
    await expect(tools.manage_dashboard_tabs.execute(tabs, {})).rejects.toThrow(/Deleting tab 11 \(B\) is disabled/);
    expect(calls).toEqual([{ method: 'manageDashboardTabs', dryRun: true }]);
  });

  it('manage_dashboard_tabs creates and renames tabs', async () => {
    setDestructiveAllowed(false);
    const { tools, calls } = guarded({});
    await tools.manage_dashboard_tabs.execute(tabs, {});
    expect(calls.map((c) => c.dryRun)).toEqual([true, undefined]);
  });

  it('dry_run still previews removals', async () => {
    setDestructiveAllowed(false);
    const { tools, calls } = guarded({ layoutRemovals: { dashcards: [{ id: 7 }], tabs: [] } });
    await tools.put_dashboard_layout.execute({ ...layout, dry_run: true }, {});
    expect(calls).toEqual([{ method: 'putDashboardLayout', dryRun: true }]);
  });
});

describe('guarded layout tools with destructive tools allowed', () => {
  it('delete as before, with no extra preview', async () => {
    setDestructiveAllowed(true);
    const { tools, calls } = guarded({ layoutRemovals: { dashcards: [{ id: 7 }], tabs: [] } });
    await tools.put_dashboard_layout.execute({ ...layout, confirm_removals: true }, {});
    expect(calls).toEqual([{ method: 'putDashboardLayout', dryRun: undefined }]);
  });
});
