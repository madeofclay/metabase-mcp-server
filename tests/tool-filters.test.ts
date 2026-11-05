import { describe, it, expect } from 'vitest';
import { parseToolFilterOptions, toolAllowed, type ToolFilterOptions } from '../src/utils/tool-filters.js';

const run = (...flags: string[]) => ['node', 'server.js', ...flags];
const opts = (mode: ToolFilterOptions['mode'], allowDestructive = false): ToolFilterOptions => ({ mode, allowDestructive });

describe('mode flags', () => {
  it('defaults to essential, without destructive tools', () => {
    expect(parseToolFilterOptions(run(), {})).toEqual(opts('essential'));
  });

  it('reads each mode flag', () => {
    expect(parseToolFilterOptions(run('--essential'), {})).toEqual(opts('essential'));
    expect(parseToolFilterOptions(run('--read'), {})).toEqual(opts('read'));
    expect(parseToolFilterOptions(run('--write'), {})).toEqual(opts('write'));
  });

  it('--all loads everything and allows destructive tools', () => {
    expect(parseToolFilterOptions(run('--all'), {})).toEqual(opts('all', true));
  });

  it('--all takes priority over the other modes', () => {
    expect(parseToolFilterOptions(run('--write', '--all'), {})).toEqual(opts('all', true));
    expect(parseToolFilterOptions(run('--essential', '--all'), {})).toEqual(opts('all', true));
  });
});

describe('METABASE_MCP_TOOLS', () => {
  it('sets the mode when no flag is given', () => {
    expect(parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: 'read' })).toEqual(opts('read'));
    expect(parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: ' Write ' })).toEqual(opts('write'));
    expect(parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: 'all' })).toEqual(opts('all', true));
  });

  it('loses to a CLI flag', () => {
    expect(parseToolFilterOptions(run('--essential'), { METABASE_MCP_TOOLS: 'all' })).toEqual(opts('essential'));
  });

  it('defaults to essential when empty', () => {
    expect(parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: '' })).toEqual(opts('essential'));
  });

  it('refuses an unknown value instead of loading another tool set', () => {
    expect(() => parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: 'everything' })).toThrow(/METABASE_MCP_TOOLS/);
  });
});

describe('allowing destructive tools', () => {
  it('is off unless asked for', () => {
    expect(parseToolFilterOptions(run('--write'), {}).allowDestructive).toBe(false);
  });

  it('is on with --allow-destructive, whatever the mode', () => {
    expect(parseToolFilterOptions(run('--write', '--allow-destructive'), {})).toEqual(opts('write', true));
    expect(parseToolFilterOptions(run('--allow-destructive'), {})).toEqual(opts('essential', true));
  });

  it('is on with METABASE_MCP_ALLOW_DESTRUCTIVE=true', () => {
    expect(parseToolFilterOptions(run(), { METABASE_MCP_TOOLS: 'write', METABASE_MCP_ALLOW_DESTRUCTIVE: 'true' }))
      .toEqual(opts('write', true));
    expect(parseToolFilterOptions(run(), { METABASE_MCP_ALLOW_DESTRUCTIVE: '1' }).allowDestructive).toBe(true);
  });

  it('stays off with a false value', () => {
    expect(parseToolFilterOptions(run(), { METABASE_MCP_ALLOW_DESTRUCTIVE: 'false' }).allowDestructive).toBe(false);
    expect(parseToolFilterOptions(run(), { METABASE_MCP_ALLOW_DESTRUCTIVE: '' }).allowDestructive).toBe(false);
  });

  it('refuses a value that is neither true nor false', () => {
    expect(() => parseToolFilterOptions(run(), { METABASE_MCP_ALLOW_DESTRUCTIVE: 'maybe' })).toThrow(/ALLOW_DESTRUCTIVE/);
  });
});

describe('toolAllowed', () => {
  it('read mode keeps only the read group', () => {
    expect(toolAllowed(opts('read'), 'search_content')).toBe(true);
    expect(toolAllowed(opts('read'), 'create_card', { isWrite: true })).toBe(false);
    expect(toolAllowed(opts('read'), 'delete_card', { isWrite: true })).toBe(false);
  });

  it('write mode keeps reads and writes but no destructive tool', () => {
    expect(toolAllowed(opts('write'), 'search_content')).toBe(true);
    expect(toolAllowed(opts('write'), 'create_card')).toBe(true);
    expect(toolAllowed(opts('write'), 'get_card_series')).toBe(true); // read tool without metadata
    for (const n of ['delete_card', 'delete_dashboard', 'delete_collection', 'delete_database',
      'update_database', 'replace_table_csv', 'update_dashboard_cards', 'revert_dashboard']) {
      expect(toolAllowed(opts('write'), n), n).toBe(false);
    }
  });

  it('write mode keeps the guarded layout tools, which then refuse to delete', () => {
    expect(toolAllowed(opts('write'), 'put_dashboard_layout')).toBe(true);
    expect(toolAllowed(opts('write'), 'manage_dashboard_tabs')).toBe(true);
  });

  it('destructive tools come back with allowDestructive', () => {
    expect(toolAllowed(opts('write', true), 'delete_card')).toBe(true);
    expect(toolAllowed(opts('write', true), 'update_database')).toBe(true);
  });

  it('essential mode keeps essential tools minus destructive ones', () => {
    expect(toolAllowed(opts('essential'), 'search_content', { isEssential: true })).toBe(true);
    expect(toolAllowed(opts('essential'), 'get_table_fks')).toBe(false);
    expect(toolAllowed(opts('essential'), 'revert_dashboard', { isEssential: true })).toBe(false);
    expect(toolAllowed(opts('essential', true), 'revert_dashboard', { isEssential: true })).toBe(true);
  });

  it('all mode keeps everything', () => {
    expect(toolAllowed(opts('all', true), 'delete_database')).toBe(true);
    expect(toolAllowed(opts('all', true), 'search_content')).toBe(true);
  });
});
