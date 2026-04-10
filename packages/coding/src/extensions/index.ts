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

export {
  registerConfiguredMcpCapabilityProvider,
} from '../capabilities/providers/mcp/index.js';

export type {
  OfficialSandboxMode,
  OfficialSandboxOptions,
} from './official-sandbox.js';

export {
  registerOfficialSandboxExtension,
} from './official-sandbox.js';
