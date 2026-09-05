/**
 * Typed MCP integration CRUD.
 *
 * FEATURE_268 stores active declarations in `integrations/mcp.json`. When that
 * file is absent, reads use the legacy `config.json#mcpServers` field. The
 * first mutation stages every legacy entry into the new document before
 * applying the requested change, so creating the authoritative file cannot
 * silently deactivate an existing server.
 */

import {
  getAgentConfigHome,
  type McpServerConfig as KodaXMcpServerConfig,
  type McpServersConfig as KodaXMcpServersConfig,
} from '@kodax-ai/agent';

import {
  parseMcpIntegrationDocument,
  readMcpIntegration,
  writeIntegrationDocument,
} from './integration-config.js';

export function listMcpServers(configHome = getAgentConfigHome()): KodaXMcpServersConfig {
  return structuredClone(readMcpIntegration(configHome).document.servers);
}

export function getMcpServerConfig(
  name: string,
  configHome = getAgentConfigHome(),
): KodaXMcpServerConfig | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const config = readMcpIntegration(configHome).document.servers[name];
  return config === undefined ? undefined : structuredClone(config);
}

export function upsertMcpServer(
  name: string,
  config: KodaXMcpServerConfig,
  configHome = getAgentConfigHome(),
): KodaXMcpServerConfig {
  validateMcpServerConfig(name, config);
  const current = readMcpIntegration(configHome);
  const stored = structuredClone(config);
  writeIntegrationDocument({
    domain: 'mcp',
    configHome,
    ...(current.source === 'user' ? { expectedRevision: current.revision } : {}),
    document: {
      version: 1,
      servers: { ...current.document.servers, [name]: stored },
    },
    validate: parseMcpIntegrationDocument,
  });
  return structuredClone(stored);
}

export function removeMcpServer(name: string, configHome = getAgentConfigHome()): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const current = readMcpIntegration(configHome);
  if (!(name in current.document.servers)) return false;
  const servers = structuredClone(current.document.servers);
  delete servers[name];
  writeIntegrationDocument({
    domain: 'mcp',
    configHome,
    ...(current.source === 'user' ? { expectedRevision: current.revision } : {}),
    document: { version: 1, servers },
    validate: parseMcpIntegrationDocument,
  });
  return true;
}

export function validateMcpServerConfig(
  name: string,
  config: KodaXMcpServerConfig,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('MCP server name must be a non-empty string');
  }
  parseMcpIntegrationDocument({ version: 1, servers: { [name]: config } });
}
