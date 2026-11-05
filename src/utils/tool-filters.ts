/**
 * Tool filtering: which tools the server registers.
 *
 * The mode comes from a CLI flag (--essential, --all, --read, --write) or, when
 * no flag is given, from METABASE_MCP_TOOLS. The variable exists for deployments
 * where changing the command line is awkward (e.g. a supervisord program): set it
 * in the program's environment instead.
 */

export type ToolMode = 'essential' | 'all' | 'read' | 'write';

export interface ToolFilterOptions {
  mode: ToolMode;
}

const MODES: readonly ToolMode[] = ['essential', 'all', 'read', 'write'];

/**
 * Resolves the tool mode. A CLI flag wins over METABASE_MCP_TOOLS; with neither,
 * the mode is 'essential'. Throws on an unknown METABASE_MCP_TOOLS value, so a
 * typo does not silently load a different tool set.
 */
export function parseToolFilterOptions(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ToolFilterOptions {
  const args = argv.slice(2);

  // Explicit flags in priority order.
  if (args.includes('--all')) return { mode: 'all' };
  if (args.includes('--write')) return { mode: 'write' };
  if (args.includes('--read')) return { mode: 'read' };
  if (args.includes('--essential')) return { mode: 'essential' };

  const fromEnv = env.METABASE_MCP_TOOLS?.trim().toLowerCase();
  if (fromEnv) {
    if (!(MODES as readonly string[]).includes(fromEnv)) {
      throw new Error(`METABASE_MCP_TOOLS must be one of ${MODES.join(', ')} (got "${env.METABASE_MCP_TOOLS}")`);
    }
    return { mode: fromEnv as ToolMode };
  }

  return { mode: 'essential' };
}

/** Whether a tool with this metadata is registered in the given mode. */
export function toolAllowed(
  mode: ToolMode,
  metadata: { isEssential?: boolean; isRead?: boolean; isWrite?: boolean } = {},
): boolean {
  switch (mode) {
    case 'essential':
      return Boolean(metadata.isEssential);
    case 'read':
      return Boolean(metadata.isRead) && !metadata.isWrite;
    case 'write':
      return Boolean(metadata.isRead || metadata.isWrite);
    case 'all':
      return true;
  }
}
