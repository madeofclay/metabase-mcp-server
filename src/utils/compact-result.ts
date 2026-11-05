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

import { validateVisualization, columnsOf } from './viz-validation.js';

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

// ── Cards and dashboards read back ──────────────────────────────────────────


function templateTagsOf(card: any): { name: string; type: string }[] {
  const dq = card?.dataset_query || {};
  const raw = dq.stages?.[0]?.['template-tags'] ?? dq.native?.['template-tags'] ?? [];
  const tags = Array.isArray(raw) ? raw : Object.values(raw);
  return tags.map((t: any) => ({ name: t.name, type: t.type }));
}

/**
 * A card reduced to what a caller needs after creating or editing it, plus a
 * check of its visualization against the columns its query returns. Warnings
 * here catch, at creation time, a trend card without a date column and the like.
 */
export function cardSummary(card: any) {
  if (!card || typeof card !== 'object' || card.id === undefined) return card;
  const cols = columnsOf(card);
  const out: any = {
    id: card.id,
    name: card.name,
    display: card.display,
    collection_id: card.collection_id,
    database_id: card.database_id,
    query_type: card.query_type,
    template_tags: templateTagsOf(card),
    columns: cols.map((c) => ({ name: c.name, type: c.effective_type || c.base_type })),
    dashboard_count: card.dashboard_count,
  };
  if (cols.length) {
    const viz = validateVisualization(card.display, card.visualization_settings, cols);
    if (viz.errors.length) out.chart_errors = viz.errors;
    if (viz.warnings.length) out.chart_warnings = viz.warnings;
  }
  return out;
}

/** create_card / update_card output: a card summary unless includeFull. */
export function cardOutput(result: any, includeFull = false): string {
  if (includeFull) return JSON.stringify(result, null, 2);
  if (result && typeof result === 'object' && result.card && result.format) {
    // update_card with sql: { card, template_tags, format }
    return JSON.stringify({ ...result, card: cardSummary(result.card), note: 'Summary only; pass include_full: true for the whole card.' }, null, 2);
  }
  return JSON.stringify({ ...cardSummary(result), note: 'Summary only; pass include_full: true for the whole card.' }, null, 2);
}

/** get_dashboard output: the summary plus one line per dashcard, unless includeFull. */
export function dashboardOutput(d: any, includeFull = false): string {
  if (includeFull || !d || typeof d !== 'object') return JSON.stringify(d, null, 2);
  const tabsOrder = new Map<number, number>((d.tabs || []).map((t: any) => [t.id, t.position ?? 0]));
  const dashcards = [...(d.dashcards || [])].sort((a: any, b: any) =>
    (tabsOrder.get(a.dashboard_tab_id) ?? 0) - (tabsOrder.get(b.dashboard_tab_id) ?? 0) || a.row - b.row || a.col - b.col);
  return JSON.stringify({
    ...dashboardSummary(d),
    description: d.description,
    filters: (d.parameters || []).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug, type: p.type, default: p.default })),
    cards: dashcards.map(dashcardSummary),
    note: 'Summary only; pass include_full: true for the whole dashboard (every card, query and setting).',
  }, null, 2);
}
