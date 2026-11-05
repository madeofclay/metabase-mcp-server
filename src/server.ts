#!/usr/bin/env node

import { FastMCP } from "fastmcp";
import { MetabaseClient } from "./client/metabase-client.js";
import { loadConfig, validateConfig } from "./utils/config.js";
import { addDashboardTools } from "./tools/dashboard-tools.js";
import { addDatabaseTools } from "./tools/database-tools.js";
import { addCardTools } from "./tools/card-tools.js";
import { addTableTools } from "./tools/table-tools.js";
import { addAdditionalTools } from "./tools/additional-tools.js";
import { parseToolFilterOptions, toolAllowed, setDestructiveAllowed } from "./utils/tool-filters.js";
import { toolAnnotations } from "./utils/tool-annotations.js";
import { createAuthenticateHandler, createClientResolver } from "./auth.js";
import { hydrateEnvFromVault } from "./utils/secrets.js";

// Parse command line arguments for tool filtering
const filterOptions = parseToolFilterOptions();
setDestructiveAllowed(filterOptions.allowDestructive);

const isHttpMode = process.env.MCP_TRANSPORT === 'http';

// In stdio mode, create a single shared client from env vars at startup.
// In httpStream mode, each client provides credentials via request headers.
let defaultClient: MetabaseClient | null = null;
if (!isHttpMode) {
  // Resolve credentials from Clay's Secrets Manager vaults (POL-SEC-001).
  // Only the API key is registered today; the username/password fallback is
  // mapped anyway because keys absent from the vault are left undefined, so
  // it starts working the day DevOps registers them — and nobody needs to
  // put a password in a supervisor conf in the meantime.
  await hydrateEnvFromVault({
    METABASE_API_KEY: "METABASE_MCP_KEY",
    METABASE_USERNAME: "METABASE_MCP_USERNAME",
    METABASE_PASSWORD: "METABASE_MCP_PASSWORD",
  });
  const config = loadConfig();
  validateConfig(config);
  defaultClient = new MetabaseClient(config);
}

const getClient = createClientResolver(defaultClient);

// Build FastMCP server options
const serverOptions: any = {
  name: "metabase-server",
  version: "2.0.1",
};

if (isHttpMode) {
  serverOptions.authenticate = createAuthenticateHandler();
}

// Create FastMCP server
const server = new FastMCP(serverOptions);

// Override addTool to apply tool filtering and attach the MCP annotations that
// clients use to group tools (read-only vs. write vs. destructive).
const originalAddTool = server.addTool.bind(server);
server.addTool = function(toolConfig: any) {
  const { metadata = {}, ...restConfig } = toolConfig;
  if (!toolAllowed(filterOptions, restConfig.name, metadata)) return;
  const annotations = toolAnnotations(restConfig.name, filterOptions.allowDestructive);
  if (!annotations) {
    console.error(`WARN: tool ${restConfig.name} has no group in src/utils/tool-annotations.ts`);
  }
  originalAddTool(annotations ? { ...restConfig, annotations: { ...annotations, ...restConfig.annotations } } : restConfig);
};

// Adding all tools — each execute calls getClient(context) internally
addDashboardTools(server, getClient);
addDatabaseTools(server, getClient);
addCardTools(server, getClient);
addTableTools(server, getClient);
addAdditionalTools(server, getClient);

// Log filtering status
console.error(`INFO: Tool filtering mode: ${filterOptions.mode} ${filterOptions.mode === 'essential' ? '(default)' : ''} · destructive tools: ${filterOptions.allowDestructive ? 'allowed' : 'off'}`);

switch (filterOptions.mode) {
  case 'essential':
    console.error(`INFO: Only essential tools loaded. Use --all or METABASE_MCP_TOOLS=all to load all tools.`);
    break;
  case 'read':
    console.error(`INFO: Read-only tools loaded.`);
    break;
  case 'write':
    console.error(`INFO: Read and write tools loaded (no destructive tools unless --allow-destructive).`);
    break;
  case 'all':
    console.error(`INFO: All tools loaded.`);
    break;
}

// Start the server
if (isHttpMode) {
  console.error(`INFO: Starting HTTP Stream transport on port ${process.env.PORT || '8011'}`);
  server.start({
    transportType: "httpStream",
    httpStream: {
      port: parseInt(process.env.PORT || '8011'),
      endpoint: "/mcp",
    },
  });
} else {
  server.start({
    transportType: "stdio",
  });
}
