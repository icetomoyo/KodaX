/**
 * @kodax-ai/mcp — MCP capability provider with progressive disclosure.
 *
 * FEATURE_082 (v0.7.24): moved from
 * `@kodax-ai/coding/src/capabilities/providers/mcp/`. Preserves the
 * progressive-disclosure modes:
 *   1. lazy connect (per-server `connect: 'lazy' | 'prewarm' | 'disabled'`)
 *   2. two-tier descriptors (McpCatalogItem vs McpCapabilityDescriptor)
 *   3. search -> describe flow
 *   4. on-disk catalog cache under .kodax/mcp/
 *
 * The coding-runtime adapter `registerConfiguredMcpCapabilityProvider` lives
 * in `@kodax-ai/coding/src/capabilities/providers/mcp-adapter.ts` — it is not
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
  McpIcon,
  McpToolTaskSupport,
  McpCatalogItem,
  McpCapabilityDescriptor,
  McpServerCatalogSnapshot,
} from './catalog.js';
export {
  defaultMcpCacheDir,
  createMcpCapabilityId,
  normalizeMcpCapabilityId,
  parseMcpCapabilityId,
  searchMcpCatalog,
  getMcpCachePaths,
} from './catalog.js';

export type { McpDiscoveryCatalog, McpServerRuntimeDiagnostics } from './runtime.js';
export { McpServerRuntime } from './runtime.js';

export type { McpProviderOptions } from './provider.js';
export { McpCapabilityProvider } from './provider.js';

// FEATURE_222 — host-injected server→client reverse capabilities.
export type {
  McpReverseCapabilities,
  McpRoot,
  McpElicitRequest,
  McpElicitResult,
  McpSamplingRequest,
  McpSamplingResult,
} from './reverse-capabilities.js';
export { buildInitializeCapabilities } from './reverse-capabilities.js';

export type { McpTransport, McpTransportEvents } from './transport.js';
export {
  createMcpTransport,
  McpAuthRequiredError,
  McpExpiredSessionError,
  McpTransportCleanupIncompleteError,
} from './transport.js';

// FEATURE_222 — MCP OAuth (discovery + interactive login). The runtime drives
// these on a 401/403; they are exported so a host can also log in proactively.
export type {
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
  DiscoveredOAuthEndpoints,
  WwwAuthenticateChallenge,
} from './oauth-discovery.js';
export {
  discoverOAuthEndpoints,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractResourceMetadataUrl,
  extractInsufficientScope,
} from './oauth-discovery.js';
export type { OAuthLoginConsent, PerformOAuthLoginOptions, OAuthClientInfo } from './oauth-login.js';
export { performOAuthLogin, loadValidToken, registerOAuthClient } from './oauth-login.js';

// v0.7.42 — popout-shape manager facade (`listServers / startServer /
// stopServer / getServerLogs / listTools`) over the capability-provider-
// shaped `McpCapabilityProvider`. See manager.ts docstring for the
// KodaX-Space-driven motivation.
export type {
  McpServerStatus,
  McpServerLogs,
  McpServerToolList,
  McpServerCatalog,
} from './manager.js';
export { McpManager, createMcpManager } from './manager.js';

// FEATURE_298 T12 — host call-context propagation for server→client requests
// (elicitation attribution). Re-exported through the package root.
export { runWithMcpCallContext, getActiveMcpCallContext } from './call-context.js';

export { createMcpTestServerFixture } from './test-helpers.js';
