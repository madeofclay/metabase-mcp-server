/**
 * Tool filtering: which tools the server registers.
 *
 * Two independent settings, each from a CLI flag or, when no flag is given, from
 * an environment variable (handy for a supervisord program):
 *
 *   mode               --essential | --read | --write | --all
 *                      METABASE_MCP_TOOLS=essential|read|write|all
 *   allowDestructive   --allow-destructive
 *                      METABASE_MCP_ALLOW_DESTRUCTIVE=true
 *
 * The groups come from src/utils/tool-annotations.ts:
 *
 *   read       only the read group
 *   write      read + write groups (+ destructive with allowDestructive)
 *   essential  the tools marked isEssential
 *   all        every tool, destructive ones included (implies allowDestructive)
 *
 * Destructive tools (deletes, replacements, database connection changes,
 * reverts) are registered only with allowDestructive. Without it, the guarded
 * write tools (put_dashboard_layout, manage_dashboard_tabs) also refuse to
 * delete dashcards or tabs. So the default deployment can build and edit, and
 * deleting is a deliberate, separate switch.
 */

import { toolGroup } from './tool-annotations.js';

export type ToolMode = 'essential' | 'all' | 'read' | 'write';

export interface ToolFilterOptions {
  mode: ToolMode;
  allowDestructive: boolean;
}

const MODES: readonly ToolMode[] = ['essential', 'all', 'read', 'write'];
const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES = ['', '0', 'false', 'no', 'off'];

/**
 * Resolves the tool mode and whether destructive tools are allowed. A CLI flag
 * wins over its environment variable. Throws on an unknown value, so a typo does
 * not silently load a different tool set.
 */
export function parseToolFilterOptions(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ToolFilterOptions {
  const args = argv.slice(2);

  let mode: ToolMode | undefined;
  // Explicit flags in priority order.
  if (args.includes('--all')) mode = 'all';
  else if (args.includes('--write')) mode = 'write';
  else if (args.includes('--read')) mode = 'read';
  else if (args.includes('--essential')) mode = 'essential';

  if (!mode) {
    const fromEnv = env.METABASE_MCP_TOOLS?.trim().toLowerCase();
    if (fromEnv) {
      if (!(MODES as readonly string[]).includes(fromEnv)) {
        throw new Error(`METABASE_MCP_TOOLS must be one of ${MODES.join(', ')} (got "${env.METABASE_MCP_TOOLS}")`);
      }
      mode = fromEnv as ToolMode;
    }
  }
  mode = mode ?? 'essential';

  let allowDestructive = args.includes('--allow-destructive');
  if (!allowDestructive) {
    const raw = (env.METABASE_MCP_ALLOW_DESTRUCTIVE ?? '').trim().toLowerCase();
    if (TRUE_VALUES.includes(raw)) allowDestructive = true;
    else if (!FALSE_VALUES.includes(raw)) {
      throw new Error(`METABASE_MCP_ALLOW_DESTRUCTIVE must be true or false (got "${env.METABASE_MCP_ALLOW_DESTRUCTIVE}")`);
    }
  }
  if (mode === 'all') allowDestructive = true;

  return { mode, allowDestructive };
}

/** Whether a tool is registered with these options. */
export function toolAllowed(
  options: ToolFilterOptions,
  name: string,
  metadata: { isEssential?: boolean; isRead?: boolean; isWrite?: boolean } = {},
): boolean {
  const group = toolGroup(name, options.allowDestructive);
  if (group === 'destructive' && !options.allowDestructive) return false;
  switch (options.mode) {
    case 'essential':
      return Boolean(metadata.isEssential);
    case 'read':
      return group === 'read';
    case 'write':
      // destructive tools already returned false above unless they are allowed
      return group === 'read' || group === 'write' || group === 'destructive';
    case 'all':
      return true;
  }
}

// ── Runtime switch read by the guarded tools ────────────────────────────────
// Defaults to allowed so library use and tests keep the previous behavior; the
// server sets it from its options at startup.

let destructiveAllowed = true;

export function setDestructiveAllowed(allowed: boolean): void {
  destructiveAllowed = allowed;
}

export function isDestructiveAllowed(): boolean {
  return destructiveAllowed;
}

/** The error a guarded tool gives when asked to delete with deleting disabled. */
export function destructiveDisabledMessage(what: string): string {
  return (
    `${what} is disabled on this server: it runs without destructive tools ` +
    `(start it with --allow-destructive or METABASE_MCP_ALLOW_DESTRUCTIVE=true to enable them). ` +
    `Keep the items in the layout, or ask an administrator to remove them.`
  );
}
