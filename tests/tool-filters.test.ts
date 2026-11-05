import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseToolFilterOptions, toolAllowed } from '../src/utils/tool-filters.js';

describe('parseToolFilterOptions', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv.slice();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('defaults to essential mode when no flags are passed', () => {
    process.argv = ['node', 'server.js'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'essential' });
  });

  it('returns essential mode for --essential flag', () => {
    process.argv = ['node', 'server.js', '--essential'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'essential' });
  });

  it('returns write mode for --write flag', () => {
    process.argv = ['node', 'server.js', '--write'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'write' });
  });

  it('returns all mode for --all flag', () => {
    process.argv = ['node', 'server.js', '--all'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'all' });
  });

  it('--all takes priority over --write', () => {
    process.argv = ['node', 'server.js', '--write', '--all'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'all' });
  });

  it('--all takes priority over --essential', () => {
    process.argv = ['node', 'server.js', '--essential', '--all'];
    expect(parseToolFilterOptions()).toEqual({ mode: 'all' });
  });
});

describe('METABASE_MCP_TOOLS', () => {
  const argv = ['node', 'server.js'];

  it('sets the mode when no flag is given', () => {
    expect(parseToolFilterOptions(argv, { METABASE_MCP_TOOLS: 'all' })).toEqual({ mode: 'all' });
    expect(parseToolFilterOptions(argv, { METABASE_MCP_TOOLS: 'read' })).toEqual({ mode: 'read' });
    expect(parseToolFilterOptions(argv, { METABASE_MCP_TOOLS: ' Write ' })).toEqual({ mode: 'write' });
  });

  it('loses to a CLI flag', () => {
    expect(parseToolFilterOptions([...argv, '--essential'], { METABASE_MCP_TOOLS: 'all' })).toEqual({ mode: 'essential' });
  });

  it('defaults to essential when empty', () => {
    expect(parseToolFilterOptions(argv, { METABASE_MCP_TOOLS: '' })).toEqual({ mode: 'essential' });
  });

  it('refuses an unknown value instead of loading another tool set', () => {
    expect(() => parseToolFilterOptions(argv, { METABASE_MCP_TOOLS: 'everything' })).toThrow(/METABASE_MCP_TOOLS/);
  });
});

describe('--read flag', () => {
  it('selects read mode', () => {
    expect(parseToolFilterOptions(['node', 'server.js', '--read'], {})).toEqual({ mode: 'read' });
  });
});

describe('toolAllowed', () => {
  it('read mode keeps read-only tools and drops anything that writes', () => {
    expect(toolAllowed('read', { isRead: true })).toBe(true);
    expect(toolAllowed('read', { isRead: true, isWrite: true })).toBe(false);
    expect(toolAllowed('read', { isWrite: true })).toBe(false);
    expect(toolAllowed('read', { isEssential: true })).toBe(false);
  });

  it('keeps the existing modes as they were', () => {
    expect(toolAllowed('essential', { isEssential: true })).toBe(true);
    expect(toolAllowed('essential', { isRead: true })).toBe(false);
    expect(toolAllowed('write', { isRead: true })).toBe(true);
    expect(toolAllowed('write', { isWrite: true })).toBe(true);
    expect(toolAllowed('write', { isEssential: true })).toBe(false);
    expect(toolAllowed('all', {})).toBe(true);
  });
});
