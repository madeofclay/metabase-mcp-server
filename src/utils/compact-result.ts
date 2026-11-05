/**
 * Compact results for the tools that write a dashboard.
 *
 * Those tools used to return the whole dashboard Metabase sent back, every
 * dashcard with its card, query and result metadata embedded. On a 24-card
 * dashboard that is 110k to 160k characters, more than a client such as Claude
 * can take in one tool result, so the useful part (what changed, the revision to
 * undo it) got lost. They now return a summary; the full dashboard (and, for a
 * dry run, the full payload) only when include_dashboard is true.
 */

const TEXT_PREVIEW = 60;

function tabSummary(tabs: any[] = [], dashcards: any[] = []) {
  return [...tabs]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((t) => ({
      id: t.id,
      name: t.name,
      cards: dashcards.filter((dc) => dc.dashboard_tab_id === t.id).length,
    }));
}

/** One line per dashcard: where it is, what it shows and how many filters reach it. */
export function dashcardSummary(dc: any) {
  const vs = dc.visualization_settings || {};
  const text: string | undefined = vs.text;
  const out: any = {
    id: dc.id,
    card_id: dc.card_id ?? null,
    tab: dc.dashboard_tab_id ?? null,
    at: `r${dc.row} c${dc.col} ${dc.size_x}x${dc.size_y}`,
  };
  const name = dc.card?.name;
  if (name) out.name = name;
  if (!dc.card_id && text !== undefined) {
    out.text = text.length > TEXT_PREVIEW ? `${text.slice(0, TEXT_PREVIEW)}…` : text;
  }
  const mappings = dc.parameter_mappings || [];
  if (mappings.length) out.filters = mappings.map((m: any) => m.parameter_id);
  if (vs['card.hide_empty']) out.hide_empty = true;
  return out;
}

/** A dashboard reduced to what a caller needs to keep working on it. */
export function dashboardSummary(d: any) {
  if (!d || typeof d !== 'object') return d;
  const dashcards = d.dashcards || [];
  return {
    id: d.id,
    name: d.name,
    collection_id: d.collection_id,
    width: d.width,
    tabs: tabSummary(d.tabs, dashcards),
    dashcards: dashcards.length,
    filters: (d.parameters || []).map((p: any) => ({ id: p.id, name: p.name, type: p.type })),
    mappings: dashcards.reduce((n: number, dc: any) => n + (dc.parameter_mappings || []).length, 0),
  };
}

function payloadSummary(p: any) {
  if (!p || typeof p !== 'object') return p;
  const out: any = {};
  if (p.tabs) out.tabs = p.tabs.map((t: any) => ({ id: t.id, name: t.name }));
  if (p.dashcards) out.dashcards = p.dashcards.map(dashcardSummary);
  if (p.parameters) out.filters = p.parameters.map((x: any) => ({ id: x.id, name: x.name, type: x.type }));
  for (const k of Object.keys(p)) {
    if (!['tabs', 'dashcards', 'parameters'].includes(k)) out[k] = p[k];
  }
  return out;
}

/** set_dashboard_filters' per-card report, one short line per card. */
function mappingsSummary(m: any[]) {
  return m.map((x) => ({
    dashcard_id: x.dashcard_id,
    card_id: x.card_id,
    mapped: (x.mapped || []).map((y: any) => `${y.parameter_id}→${y.tag}`),
    ...(x.not_applicable?.length ? { not_applicable: x.not_applicable } : {}),
    ...(x.excluded?.length ? { excluded: x.excluded } : {}),
  }));
}

function isDashboardWriteResult(r: any): boolean {
  return !!r && typeof r === 'object' && 'diff' in r && 'previous_revision_id' in r;
}

/**
 * Compacts a dashboard-write result unless includeDashboard is set. Results of
 * other shapes pass through untouched.
 */
export function compactResult(result: any, includeDashboard = false): any {
  if (includeDashboard || !isDashboardWriteResult(result)) return result;
  const out: any = { ...result };
  if (out.dashboard) out.dashboard = dashboardSummary(out.dashboard);
  if (out.payload) out.payload = payloadSummary(out.payload);
  if (Array.isArray(out.mappings)) out.mappings = mappingsSummary(out.mappings);
  if (Object.keys(result).some((k) => k === 'dashboard' || k === 'payload')) {
    out.note = 'Summary only; pass include_dashboard: true for the full dashboard.';
  }
  return out;
}

/** JSON for a tool result, compacted when it is a dashboard write. */
export function toolOutput(result: any, includeDashboard = false): string {
  return JSON.stringify(compactResult(result, includeDashboard), null, 2);
}
