/**
 * Coding-runtime adapter: registers an `McpCapabilityProvider` (from
 * `@kodax/mcp`) against the coding-specific `KodaXExtensionRuntime`.
 *
 * FEATURE_082 (v0.7.24): split out of the old
 * `capabilities/providers/mcp/provider.ts`. The provider class now lives in
 * `@kodax/mcp` and stays free of any coding runtime dependency; this file
 * is the thin bridge that wires the provider into the coding extension
 * runtime.
 */

import { McpCapabilityProvider, type McpProviderOptions } from '@kodax/mcp';
import type { McpServersConfig } from '@kodax/mcp';
import type { KodaXExtensionRuntime } from '../../extensions/runtime.js';

export async function registerConfiguredMcpCapabilityProvider(
  runtime: KodaXExtensionRuntime,
  servers: McpServersConfig | undefined,
  options: McpProviderOptions = {},
): Promise<McpCapabilityProvider | undefined> {
  const provider = new McpCapabilityProvider(servers, options);
  if (!provider.hasActiveServers()) {
    return undefined;
  }

  runtime.registerCapabilityProvider(provider, {
    source: {
      kind: 'runtime',
      id: 'runtime:capability:mcp',
      label: 'MCP Capability Provider',
    },
  });
  await provider.prewarm();
  return provider;
}
