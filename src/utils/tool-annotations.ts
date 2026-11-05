/**
 * MCP tool annotations (spec 2025-03-26): how each tool touches Metabase.
 *
 * Clients group tools by these hints. Claude.ai shows read-only tools apart from
 * the ones that write or delete, and lets an organization or a user allow, ask
 * for, or block each group. Without annotations every tool lands in a single
 * «Other tools» group, so a database connection and a search look the same.
 *
 * Every tool the server registers has to be listed here: tests fail on a tool
 * without a group, so a new tool cannot ship unclassified.
 *
 *   read         only reads or runs queries; changes nothing in Metabase
 *   write        creates or edits content; nothing existing is lost
 *   destructive  deletes, replaces or overwrites existing content or settings
 */

export type ToolGroup = 'read' | 'write' | 'destructive';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const READ = [
  // dashboards
  'list_dashboards', 'get_dashboard', 'get_dashboard_cards', 'get_dashboard_related',
  'get_dashboard_revisions', 'list_embeddable_dashboards', 'list_public_dashboards',
  'run_dashcards', 'execute_dashboard_card', 'search_dashboards', 'get_dashboard_queries',
  'audit_dashboard_filters',
  // databases
  'list_databases', 'get_database', 'check_database_health',
  'get_database_metadata', 'list_database_schemas', 'get_database_schema',
  'execute_query', 'test_native_query',
  // cards
  'list_cards', 'get_card', 'execute_card', 'preview_card', 'export_card_result', 'get_card_dashboards',
  'list_embeddable_cards', 'list_public_cards', 'execute_pivot_card_query',
  'get_card_param_values', 'search_card_param_values', 'get_card_param_remapping',
  'get_card_query_metadata', 'get_card_series',
  // tables
  'list_tables', 'get_table', 'get_table_fks', 'get_table_query_metadata', 'get_table_related',
  'get_card_table_fks', 'get_card_table_query_metadata', 'get_table_data', 'get_field_id',
  // collections, search, users
  'get_collection_items', 'search_content', 'list_collections', 'list_users',
  'get_metabase_playground_link',
] as const;

const WRITE = [
  // dashboards
  'create_dashboard', 'copy_dashboard', 'add_card_to_dashboard', 'set_dashboard_filters',
  'add_text_block', 'save_dashboard', 'save_dashboard_to_collection', 'update_dashboard',
  'update_dashcard', 'create_public_link',
  // databases. validate_database saves nothing, but it makes Metabase connect to
  // a host and credentials the caller chooses, so it stays out of the read group.
  'create_database', 'validate_database', 'add_sample_database', 'sync_database_schema',
  // cards
  'create_card', 'update_card', 'copy_card', 'move_cards', 'move_cards_to_collection',
  'create_card_public_link',
  // tables
  'update_tables', 'update_table', 'append_csv_to_table', 'reorder_table_fields',
  'rescan_table_field_values', 'sync_table_schema',
  // collections
  'move_to_collection', 'create_collection', 'update_collection',
] as const;

/** Marking something as a favorite twice leaves it the same. */
const IDEMPOTENT_WRITE = ['favorite_dashboard', 'unfavorite_dashboard'] as const;

/**
 * Write tools that can also delete, and refuse to unless destructive tools are
 * allowed (--allow-destructive or --all): put_dashboard_layout without
 * confirm_removals and manage_dashboard_tabs without deleting a tab only create
 * and edit. They count as write tools then, and as destructive ones when
 * deleting is allowed.
 */
export const GUARDED_TOOLS = ['put_dashboard_layout', 'manage_dashboard_tabs'] as const;

const DESTRUCTIVE = [
  // dashboards: these drop dashcards, replace them all, or roll back to an older version
  'update_dashboard_cards', 'remove_cards_from_dashboard', 'revert_dashboard', 'delete_dashboard',
  'delete_public_link',
  // databases: connection settings and the connection itself
  'update_database', 'delete_database',
  // cards
  'delete_card', 'delete_card_public_link',
  // tables
  'replace_table_csv', 'discard_table_field_values',
  // collections
  'delete_collection',
] as const;

type Kind = ToolGroup | 'idempotent-write' | 'guarded';

const GROUPS = new Map<string, Kind>();
for (const n of READ) GROUPS.set(n, 'read');
for (const n of WRITE) GROUPS.set(n, 'write');
for (const n of IDEMPOTENT_WRITE) GROUPS.set(n, 'idempotent-write');
for (const n of GUARDED_TOOLS) GROUPS.set(n, 'guarded');
for (const n of DESTRUCTIVE) GROUPS.set(n, 'destructive');

/** Every classified tool name, for tests. */
export const CLASSIFIED_TOOLS: readonly string[] = [...GROUPS.keys()];

/**
 * The group of a tool, or undefined when it is not classified. A guarded tool is
 * a write tool unless destructive tools are allowed.
 */
export function toolGroup(name: string, allowDestructive = false): ToolGroup | undefined {
  const g = GROUPS.get(name);
  if (g === 'idempotent-write') return 'write';
  if (g === 'guarded') return allowDestructive ? 'destructive' : 'write';
  return g;
}

/**
 * The annotations for a tool, or undefined when it is not classified. Every tool
 * reaches only the Metabase instance it is configured for, so openWorldHint is
 * false throughout.
 */
export function toolAnnotations(name: string, allowDestructive = false): ToolAnnotations | undefined {
  const kind = GROUPS.get(name);
  switch (kind === 'guarded' ? (allowDestructive ? 'destructive' : 'write') : kind) {
    case 'read':
      return { readOnlyHint: true, openWorldHint: false };
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    case 'idempotent-write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case 'destructive':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    default:
      return undefined;
  }
}
