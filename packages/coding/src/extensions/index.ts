export type {
  CapabilityKind,
  CapabilityResult,
  CapabilityProvider,
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

export {
  KodaXExtensionRuntime,
  createExtensionRuntime,
  setActiveExtensionRuntime,
  getActiveExtensionRuntime,
  emitActiveExtensionEvent,
  runActiveExtensionHook,
} from './runtime.js';

// FEATURE_082 (v0.7.24): MCP provider moved to `@kodax/mcp`; the coding
// runtime adapter (the function below) now lives beside the package boundary.
export {
  registerConfiguredMcpCapabilityProvider,
} from '../capabilities/providers/mcp-adapter.js';

export type {
  OfficialSandboxMode,
  OfficialSandboxOptions,
} from './official-sandbox.js';

export {
  registerOfficialSandboxExtension,
} from './official-sandbox.js';

export { exec, webhook } from './helpers.js';
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';
