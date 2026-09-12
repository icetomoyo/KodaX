export type {
  CapabilityKind,
  CapabilityResult,
  CapabilityProvider,
  ExtensionCapabilityProvider,
  CapabilitySearchFailure,
  CapabilitySearchFreshness,
  CapabilitySearchOptions,
  CapabilitySearchSnapshot,
  ModelProviderRegistration,
  ExtensionCommandDefinition,
  ExtensionCommandContext,
  ExtensionCommandInvocation,
  ExtensionCommandResult,
  ExtensionContributionSource,
  ExtensionLoadSource,
  ExtensionLogger,
  ExtensionToolBeforeHookContext,
  ExtensionEventMap,
  ExtensionHookMap,
  ExtensionRuntimeController,
  LoadedExtensionDiagnostic,
  RegisteredCapabilityProviderDiagnostic,
  RegisteredCommandDiagnostic,
  RegisteredHookDiagnostic,
  RegisteredToolDiagnostic,
  ExtensionFailureStage,
  ExtensionFailureDiagnostic,
  ExtensionRuntimeDiagnostics,
  KodaXExtensionAPI,
  KodaXExtensionActivationResult,
  KodaXExtensionModule,
} from './types.js';
export type { ExtensionExecutionScope } from './execution-contract.js';

export {
  CombinedExtensionRuntime,
  KodaXExtensionRuntime,
  combineExtensionRuntimes,
  createExtensionRuntime,
  setActiveExtensionRuntime,
  getActiveExtensionRuntime,
  emitActiveExtensionEvent,
  runActiveExtensionHook,
} from './runtime.js';

// FEATURE_082 (v0.7.24): MCP provider moved to `@kodax-ai/agent`; the coding
// runtime adapter (the function below) now lives beside the package boundary.
export {
  registerConfiguredMcpCapabilityProvider,
  replaceConfiguredMcpCapabilityProvider,
} from '../capabilities/providers/mcp-adapter.js';

// FEATURE_222 — host helper that builds the MCP reverse-capability handlers
// (roots, …) from the workspace, to inject into the provider.
export {
  buildMcpReverseCapabilities,
  mcpRootsFromWorkspace,
  type McpReverseWorkspace,
} from '../capabilities/providers/mcp-reverse.js';

export type {
  OfficialSandboxMode,
  OfficialSandboxOptions,
} from './official-sandbox.js';

export {
  registerOfficialSandboxExtension,
} from './official-sandbox.js';

export { exec, webhook } from './helpers.js';
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';

export {
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  discoverExtensionsInDirectory,
  discoverExtensionsInDirectoryDetailed,
  excludeExtensionPathsByEntrypoint,
  getDefaultExtensionDirectory,
  isSupportedExtensionModulePath,
  resolveExtensionEntrypoint,
} from './discovery.js';
export type {
  ExtensionDiscoveryResult,
  ExtensionDiscoverySkipReason,
  SkippedExtensionDiscoveryEntry,
} from './discovery.js';
export type {
  BoundExtensionRuntimeController,
  CapabilityRuntimeContract,
  ExtensionRuntimeContract,
  RuntimeDefaultsSnapshot,
} from './runtime-contract.js';
