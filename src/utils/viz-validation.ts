/**
 * Checks that a card's visualization can be drawn from the columns its query
 * returns.
 *
 * A query that runs is not a chart that renders. A trend card (smartscalar)
 * fed by a query without a date column, or a bar chart whose graph.metrics names
 * a column the query no longer returns, runs fine and then shows «Something went
 * wrong» on the dashboard. run_dashcards used to report those cards as «ok».
 * These checks run on the result columns (or the card's result_metadata) and
 * name the problem in words.
 *
 * Errors mean the chart will not render; warnings mean a setting points at a
 * column that is not there (the chart may still draw, without it). This does not
 * replace looking at the card in the browser: Metabase 0.63 has no API that
 * renders a card as an image (GET /api/pulse/preview_card_png existed up to 0.50).
 */

export interface Column {
  name: string;
  base_type?: string;
  effective_type?: string;
  display_name?: string;
}

export interface VizProblems {
  errors: string[];
  warnings: string[];
}

const NUMERIC = ['type/Integer', 'type/BigInteger', 'type/Decimal', 'type/Float', 'type/Number'];
const TEMPORAL = ['type/Date', 'type/DateTime', 'type/DateTimeWithTZ', 'type/DateTimeWithLocalTZ',
  'type/DateTimeWithZoneID', 'type/DateTimeWithZoneOffset', 'type/Temporal', 'type/Instant'];

function typeOf(c: Column): string {
  return c.effective_type || c.base_type || '';
}
export const isNumeric = (c: Column) => NUMERIC.includes(typeOf(c));
export const isTemporal = (c: Column) => TEMPORAL.includes(typeOf(c));

const GRAPH = ['line', 'area', 'bar', 'combo', 'row', 'scatter', 'waterfall'];

/** Column names referenced by `column_settings` keys like '["name","Ventas"]'. */
function columnSettingNames(vs: any): string[] {
  const out: string[] = [];
  for (const key of Object.keys(vs?.column_settings || {})) {
    try {
      const ref = JSON.parse(key);
      if (Array.isArray(ref) && ref[0] === 'name' && typeof ref[1] === 'string') out.push(ref[1]);
    } catch { /* other key shapes are not checked */ }
  }
  return out;
}

const list = (xs: string[]) => xs.map((x) => `«${x}»`).join(', ');

export function validateVisualization(display: string | undefined, vs: any = {}, cols: Column[] = []): VizProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  vs = vs || {};
  const d = display || 'table';
  const byName = new Map(cols.map((c) => [c.name, c]));
  const have = (n: string) => byName.has(n);
  const numeric = cols.filter(isNumeric);
  const temporal = cols.filter(isTemporal);
  const names = cols.map((c) => c.name);

  // Nothing to check against (no result metadata): the caller decides what that means.
  if (cols.length === 0) return { errors, warnings };

  if (d === 'smartscalar') {
    if (temporal.length === 0) {
      errors.push(`A trend card needs a date column to compare periods, and the query returns none (columns: ${list(names)}). Return a date or month column first, or use a «scalar» card.`);
    }
    if (numeric.length === 0) errors.push(`A trend card needs a numeric column, and the query returns none (columns: ${list(names)}).`);
    const field = vs['scalar.field'];
    if (field && !have(field)) errors.push(`scalar.field is «${field}», which the query does not return (columns: ${list(names)}).`);
    else if (field && !isNumeric(byName.get(field)!)) errors.push(`scalar.field «${field}» is not numeric.`);
    for (const cmp of vs['scalar.comparisons'] || []) {
      if (cmp?.type === 'anotherColumn' && cmp.column && !have(cmp.column)) {
        errors.push(`The comparison against another column uses «${cmp.column}», which the query does not return.`);
      }
      if (cmp?.type === 'anotherColumn' && temporal.length === 0) {
        errors.push('A comparison against another column still needs the trend card to have a date column.');
      }
    }
  } else if (d === 'scalar') {
    const field = vs['scalar.field'];
    if (field && !have(field)) errors.push(`scalar.field is «${field}», which the query does not return (columns: ${list(names)}).`);
  } else if (GRAPH.includes(d)) {
    const dims: string[] = (vs['graph.dimensions'] || []).filter(Boolean);
    const mets: string[] = (vs['graph.metrics'] || []).filter(Boolean);
    const missingDims = dims.filter((n) => !have(n));
    const missingMets = mets.filter((n) => !have(n));
    if (missingDims.length) errors.push(`graph.dimensions names ${list(missingDims)}, not returned by the query (columns: ${list(names)}).`);
    if (missingMets.length) errors.push(`graph.metrics names ${list(missingMets)}, not returned by the query (columns: ${list(names)}).`);
    const nonNumeric = mets.filter((n) => have(n) && !isNumeric(byName.get(n)!));
    if (nonNumeric.length && d !== 'scatter') errors.push(`graph.metrics ${list(nonNumeric)} must be numeric.`);
    if (!dims.length && !mets.length) {
      if (cols.length < 2) errors.push(`A ${d} chart needs at least two columns (a category or date and a number); the query returns ${list(names)}.`);
      else if (numeric.length === 0) errors.push(`A ${d} chart needs a numeric column; the query returns ${list(names)}.`);
    }
  } else if (d === 'pie') {
    const dim = vs['pie.dimension'];
    const met = vs['pie.metric'];
    const dimList: string[] = Array.isArray(dim) ? dim : dim ? [dim] : [];
    const missing = dimList.filter((n) => !have(n));
    if (missing.length) errors.push(`pie.dimension names ${list(missing)}, not returned by the query.`);
    if (met && !have(met)) errors.push(`pie.metric is «${met}», not returned by the query.`);
    else if (met && !isNumeric(byName.get(met)!)) errors.push(`pie.metric «${met}» must be numeric.`);
    if (!dimList.length && !met && (cols.length < 2 || numeric.length === 0)) {
      errors.push(`A pie chart needs a category column and a numeric one; the query returns ${list(names)}.`);
    }
  } else if (d === 'gauge' || d === 'progress') {
    if (numeric.length === 0) errors.push(`A ${d} card needs a numeric column; the query returns ${list(names)}.`);
  } else if (d === 'funnel') {
    if (cols.length < 2 || numeric.length === 0) errors.push(`A funnel needs a step column and a numeric one; the query returns ${list(names)}.`);
  }

  const missingSettings = columnSettingNames(vs).filter((n) => !have(n));
  if (missingSettings.length) warnings.push(`column_settings formats ${list(missingSettings)}, which the query does not return; that formatting is ignored.`);
  const tableCols: string[] = (vs['table.columns'] || []).map((c: any) => c?.name).filter(Boolean);
  const missingTable = tableCols.filter((n) => !have(n));
  if (missingTable.length) warnings.push(`table.columns lists ${list(missingTable)}, which the query does not return.`);

  return { errors, warnings };
}

/** Columns from a query result (data.cols) or a card's result_metadata. */
export function columnsOf(source: any): Column[] {
  const cols = source?.data?.cols ?? source?.result_metadata ?? source;
  return Array.isArray(cols) ? cols.filter((c: any) => c && typeof c.name === 'string') : [];
}

/** A dashcard's effective settings: the card's, overridden by the dashcard's. */
export function effectiveSettings(cardVs: any = {}, dashcardVs: any = {}): any {
  const out: any = { ...(cardVs || {}) };
  for (const [k, v] of Object.entries(dashcardVs || {})) {
    if (k === 'column_settings' && v && typeof v === 'object') {
      out.column_settings = { ...(out.column_settings || {}), ...(v as any) };
    } else {
      out[k] = v;
    }
  }
  return out;
}
