/**
 * @kodax/mcp — MCP capability provider with progressive disclosure.
 *
 * FEATURE_082 (v0.7.24): moved from
 * `@kodax/coding/src/capabilities/providers/mcp/`. Preserves all five
 * progressive-disclosure modes:
 *   1. lazy connect (per-server `connect: 'lazy' | 'prewarm' | 'disabled'`)
 *   2. two-tier descriptors (McpCatalogItem vs McpCapabilityDescriptor)
 *   3. search -> describe flow
 *   4. elicitation for missing tool args
 *   5. on-disk catalog cache under .kodax/mcp/
 *
 * The coding-runtime adapter `registerConfiguredMcpCapabilityProvider` lives
 * in `@kodax/coding/src/capabilities/providers/mcp-adapter.ts` — it is not
 * exported from this package because it depends on `KodaXExtensionRuntime`.
 */

export type {
  McpServerConfig,
  McpServersConfig,
  McpTransportKind,
  McpConnectMode,
} from './config.js';

export type {
  McpCapabilityKind,
  McpCapabilityRisk,
  McpCatalogItem,
  McpCapabilityDescriptor,
  McpServerCatalogSnapshot,
} from './catalog.js';
export {
  defaultMcpCacheDir,
  createMcpCapabilityId,
  parseMcpCapabilityId,
  searchMcpCatalog,
  getMcpCachePaths,
} from './catalog.js';

export type { McpServerRuntimeDiagnostics } from './runtime.js';
export { McpServerRuntime } from './runtime.js';

export type { McpProviderOptions } from './provider.js';
export { McpCapabilityProvider } from './provider.js';

export type { McpTransport, McpTransportEvents } from './transport.js';
export { createMcpTransport } from './transport.js';

export { createMcpTestServerFixture } from './test-helpers.js';
