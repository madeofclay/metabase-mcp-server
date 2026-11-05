import { describe, it, expect } from 'vitest';
import { addDashboardTools } from '../src/tools/dashboard-tools.js';
import { addDatabaseTools } from '../src/tools/database-tools.js';
import { addCardTools } from '../src/tools/card-tools.js';
import { addTableTools } from '../src/tools/table-tools.js';
import { addAdditionalTools } from '../src/tools/additional-tools.js';
import { CLASSIFIED_TOOLS, toolAnnotations, toolGroup } from '../src/utils/tool-annotations.js';

function registeredTools(): { name: string; metadata?: any }[] {
  const tools: { name: string; metadata?: any }[] = [];
  const server = { addTool: (t: any) => tools.push({ name: t.name, metadata: t.metadata }) };
  const getClient = () => null as any;
  addDashboardTools(server, getClient);
  addDatabaseTools(server, getClient);
  addCardTools(server, getClient);
  addTableTools(server, getClient);
  addAdditionalTools(server, getClient);
  return tools;
}

describe('tool annotations', () => {
  const tools = registeredTools();
  const names = tools.map((t) => t.name);

  it('classifies every registered tool', () => {
    const missing = names.filter((n) => !toolGroup(n));
    expect(missing).toEqual([]);
  });

  it('classifies no tool that does not exist', () => {
    const unknown = CLASSIFIED_TOOLS.filter((n) => !names.includes(n));
    expect(unknown).toEqual([]);
  });

  it('puts each tool in exactly one group', () => {
    expect(new Set(CLASSIFIED_TOOLS).size).toBe(CLASSIFIED_TOOLS.length);
    expect(CLASSIFIED_TOOLS.length).toBe(names.length);
  });

  it('marks read-only tools as read-only and nothing else', () => {
    expect(toolAnnotations('search_content')).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(toolAnnotations('run_dashcards')?.readOnlyHint).toBe(true);
    expect(toolAnnotations('execute_query')?.readOnlyHint).toBe(true);
    // saves nothing, but connects to a host the caller picks: kept out of read-only
    expect(toolAnnotations('validate_database')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('marks deletes, replacements and connection changes as destructive', () => {
    for (const n of [
      'delete_card', 'delete_dashboard', 'delete_collection', 'delete_database', 'update_database',
      'replace_table_csv', 'update_dashboard_cards', 'revert_dashboard', 'remove_cards_from_dashboard',
    ]) {
      expect(toolAnnotations(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('marks the guarded layout tools as writes, and as destructive only when deleting is allowed', () => {
    for (const n of ['put_dashboard_layout', 'manage_dashboard_tabs']) {
      expect(toolAnnotations(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(toolAnnotations(n, true), n).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(toolGroup(n)).toBe('write');
      expect(toolGroup(n, true)).toBe('destructive');
    }
  });

  it('marks creating and editing as non-destructive writes', () => {
    for (const n of ['create_card', 'update_card', 'create_dashboard', 'set_dashboard_filters', 'create_collection']) {
      expect(toolAnnotations(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(toolAnnotations('favorite_dashboard')).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it('never calls a tool read-only when its metadata says it writes', () => {
    const wrong = tools.filter((t) => t.metadata?.isWrite && toolGroup(t.name) === 'read').map((t) => t.name);
    expect(wrong).toEqual([]);
  });
});
