/**
 * Template tags of native SQL questions: {{name}} variables.
 *
 * Metabase only treats {{name}} as a variable when the query declares a matching
 * template tag. Snippets ({{snippet: x}}) and card references ({{#123-x}}) are
 * tags of another kind with their own ids: they are never generated here, and
 * the ones a card already has are kept as they are.
 *
 * Two formats exist. Legacy queries keep tags as an object keyed by name in
 * native['template-tags']; MBQL 5, which Metabase 0.63 returns from GET
 * /api/card/:id, keeps them as a list in stages[0]['template-tags']. Verified on
 * 0.63: PUT /api/card/:id with the GET's MBQL 5 dataset_query, changing
 * stages[0].native and its 'template-tags' list, updates the card.
 */

export type VariableType = 'date' | 'text' | 'number';

export interface TemplateTag {
  id: string;
  name: string;
  'display-name': string;
  type: string;
  [key: string]: unknown;
}

export interface TagOverride {
  type?: VariableType;
  display_name?: string;
}

const VARIABLE_TYPES: readonly VariableType[] = ['date', 'text', 'number'];

/** A snippet or card reference: tags that are not plain variables. */
function isReference(name: string): boolean {
  return /^snippet\s*:/i.test(name) || name.startsWith('#');
}

/** The plain variable names in a SQL query, in order of appearance, without repeats. */
export function variableNames(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = m[1];
    if (isReference(name) || !/^\w+$/.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The names of the snippet and card references in a query, as Metabase names their tags. */
function referenceNames(sql: string): Set<string> {
  const refs = new Set<string>();
  for (const m of sql.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (isReference(m[1])) refs.add(m[1]);
  }
  return refs;
}

/** Tags as a list, whichever format they come in. */
export function tagList(tags: unknown): TemplateTag[] {
  if (Array.isArray(tags)) return tags as TemplateTag[];
  if (tags && typeof tags === 'object') return Object.values(tags as Record<string, TemplateTag>);
  return [];
}

export function tagObject(tags: TemplateTag[]): Record<string, TemplateTag> {
  return Object.fromEntries(tags.map((t) => [t.name, t]));
}

/**
 * The tags a query needs. A variable that already had a tag keeps its id, type
 * and display name unless `overrides` says otherwise; a new one gets id
 * `${name}-${cardKey}` and type `text` unless told. Existing snippet and card
 * reference tags still used by the query are kept untouched.
 */
export function buildTemplateTags(
  sql: string,
  cardKey: number | 'new',
  overrides: Record<string, TagOverride> = {},
  existing: TemplateTag[] = [],
): TemplateTag[] {
  const names = variableNames(sql);
  for (const [name, o] of Object.entries(overrides)) {
    if (!names.includes(name)) {
      throw new Error(`template_tags names "${name}", but the query has no {{${name}}}`);
    }
    if (o.type !== undefined && !VARIABLE_TYPES.includes(o.type)) {
      throw new Error(`template_tags.${name}.type must be one of ${VARIABLE_TYPES.join(', ')}`);
    }
  }
  const byName = new Map(existing.map((t) => [t.name, t]));
  const variables = names.map((name) => {
    const prev = byName.get(name);
    const o = overrides[name] || {};
    const base: TemplateTag = prev && !isReference(name)
      ? { ...prev }
      : { id: `${name}-${cardKey}`, name, 'display-name': name, type: 'text' };
    if (o.type) base.type = o.type;
    if (o.display_name) base['display-name'] = o.display_name;
    return base;
  });
  const refs = referenceNames(sql);
  const keptRefs = existing.filter((t) => refs.has(t.name));
  return [...variables, ...keptRefs];
}

/** The variable type a dashboard filter type can feed, or undefined. */
export function variableTypeForFilter(filterType: string): VariableType | undefined {
  if (filterType.startsWith('date/')) return 'date';
  if (filterType.startsWith('string/') || filterType === 'category') return 'text';
  if (filterType.startsWith('number/')) return 'number';
  return undefined;
}

/** The native SQL and tags of a card's query, MBQL 5 or legacy; undefined when it is not native. */
export function nativeQueryOf(datasetQuery: any): { sql: string; tags: TemplateTag[]; format: 'mbql5' | 'legacy' } | undefined {
  if (!datasetQuery) return undefined;
  if (Array.isArray(datasetQuery.stages)) {
    const stage = datasetQuery.stages[0];
    if (!stage || typeof stage.native !== 'string') return undefined;
    return { sql: stage.native, tags: tagList(stage['template-tags']), format: 'mbql5' };
  }
  if (datasetQuery.type === 'native' && datasetQuery.native) {
    return { sql: datasetQuery.native.query || '', tags: tagList(datasetQuery.native['template-tags']), format: 'legacy' };
  }
  return undefined;
}
