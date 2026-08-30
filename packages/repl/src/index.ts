/**
 * @kodax-ai/repl - KodaX 完整的交互式终端体验
 *
 * 提供两个入口：
 * - Ink UI (推荐): 现代化 React 终端 UI
 * - 传统 REPL: Node.js readline 实现
 */

// === 主入口：Ink UI ===
export { runInkInteractiveMode } from "./ui/index.js";
export type {
  InkREPLOptions,
  InkRuntimeRunner,
  InkRuntimeRunnerInput,
  InkRuntimeStatusProvider,
  InkTransientNotice,
} from "./ui/index.js";

// === 传统 REPL 入口 ===
export {
  runInteractiveMode,
  processSpecialSyntax,
  type RepLOptions,
  type ReplRuntimeRunner,
  type ReplRuntimeRunnerInput,
  type ReplRuntimeStatusProvider,
} from "./interactive/repl.js";

// === UI 组件 ===
export * from "./ui/index.js";
export {
  detectTerminalRenderHost,
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  isRemoteConptyHost,
  isTmuxControlMode,
  isVsCodeTerminalHostEnv,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  isOwnedRendererPreferred,
  isClassicReplForced,
} from "./ui/utils/terminal-host-profile.js";
export type {
  EffectiveTuiRendererMode,
  FullscreenPolicy,
  InteractiveSurfacePreference,
  TerminalHostCapabilities,
  TerminalHostDetectionOptions,
  TerminalHostProfile,
  TerminalRenderHost,
  TuiRendererMode,
} from "./ui/utils/terminal-host-profile.js";

// === 交互式命令系统 ===
export {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
} from "./interactive/context.js";
export {
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  getCommandRegistry,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
} from "./interactive/commands.js";
export {
  createUserSkillInvocation,
  resolveUserSkillInvocation,
} from "./interactive/user-skill-invocation.js";
export {
  prepareInvocationExecution,
  type PreparedInvocation,
} from "./interactive/invocation-runtime.js";
export type {
  RuntimeSurfaceMode,
  RuntimeSurfaceStatus,
} from "./commands/types.js";
export { listRegisteredCommands } from "./commands/index.js";
export type { CommandInfo } from "./commands/index.js";

// === 共享工具 ===
export {
  getVersion,
  KODAX_VERSION,
  getProviderModel,
  getProviderList,
  isProviderConfigured,
  hydrateProcessEnvFromShell,
  loadConfig,
  ensureExampleConfigFiles,
  ensureExampleConfigFile,
  getConfigTemplate,
  CONFIG_TEMPLATES,
  prepareRuntimeConfig,
  inspectConfigEnvironmentSource,
  KODAX_CONFIG_ENV_BINDINGS,
  resolveRuntimeProviderSelection,
  resolveRuntimeModelSelection,
  resolveRuntimeEffortSelection,
  registerConfiguredCustomProviders,
  saveConfig,
  getGitRoot,
  rateLimitedCall,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_CONFIG_FILE,
  KODAX_EXAMPLE_CONFIG_FILE,
  KODAX_INTEGRATION_EXAMPLE_FILES,
  PREVIEW_MAX_LENGTH,
} from "./common/utils.js";
export type {
  ConfigEnvironmentSource,
  ConfigTemplateName,
} from "./common/utils.js";

// === Typed Auto-mode settings resolver (FEATURE_271, v0.7.73) ===
export {
  loadAutoModeSettings,
  resolveAutoModeSettings,
} from "./common/permission-config.js";
export type {
  AutoModeSettings,
  ResolvedAutoModeSettings,
  ResolveAutoModeSettingsInput,
} from "./common/permission-config.js";

// === Custom provider CRUD (v0.7.42 SDK export) ===
// SDK embedders (KodaX Space etc.) can add / remove `customProviders`
// entries in `~/.kodax/config.json` without re-implementing the schema
// or the in-memory re-registration step. See common/custom-providers.ts
// for the trust-boundary rationale (gap 7).
export {
  listCustomProviders,
  getCustomProviderConfig,
  upsertCustomProvider,
  removeCustomProvider,
} from "./common/custom-providers.js";

// === First-run provider setup (FEATURE_271, v0.7.73) ===
// Metadata-only setup: these APIs never accept an API-key value.
export {
  ProviderSetupConfigConflictError,
  ProviderSetupInvalidConfigError,
  getProviderSetupCatalog,
  inspectProviderSetupReadiness,
  persistProviderSetupChoice,
  providerSetupRestartInstructions,
} from "./common/provider-setup.js";
export type {
  ProviderSetupCatalogEntry,
  ProviderSetupChoice,
  ProviderSetupCustomProviderMetadata,
  ProviderSetupReadiness,
  PersistedProviderSetupChoice,
} from "./common/provider-setup.js";
export { runProviderSetupWizard } from "./interactive/provider-setup.js";
export type {
  ProviderSetupInteraction,
  ProviderSetupWizardResult,
  RunProviderSetupWizardInput,
} from "./interactive/provider-setup.js";
export { initializeSetupConfiguration } from "./common/setup-config.js";
export type {
  InitializeSetupConfigurationInput,
  SetupConfigDomain,
  SetupConfigFileKind,
  SetupConfigFileResult,
  SetupConfigFileStatus,
  SetupConfigurationResult,
} from "./common/setup-config.js";
export { renderSetupGuide } from "./common/setup-guide.js";
export type { RenderSetupGuideInput } from "./common/setup-guide.js";
export {
  CoreConfigWriteConflictError,
  coreConfigWriteLockPath,
  withCoreConfigWriteLock,
} from "./common/core-config-lock.js";

// === MCP server CRUD (v0.7.42 SDK export) ===
// SDK embedders (KodaX Space etc.) can add / remove `mcpServers` entries
// in `~/.kodax/config.json` from a popout UI without re-implementing the
// shape validation. New entries take effect on the NEXT `runKodaX` /
// `startKodaX` invocation; in-flight runs keep their startup snapshot.
// See common/mcp-servers.ts for the trust-boundary rationale.
export {
  listMcpServers,
  getMcpServerConfig,
  upsertMcpServer,
  removeMcpServer,
  validateMcpServerConfig,
} from "./common/mcp-servers.js";

export {
  IntegrationConfigController,
  IntegrationConfigConflictError,
  migrateLegacyIntegrationConfig,
  planLegacyIntegrationMigration,
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  readExtensionsIntegration,
  readMcpIntegration,
  resolveIntegrationConfigPath,
  writeIntegrationDocument,
} from "./common/integration-config.js";
export type {
  ExtensionsIntegrationDocument,
  IntegrationConfigDiagnostic,
  IntegrationConfigListener,
  IntegrationConfigSnapshot,
  IntegrationConfigSource,
  IntegrationConfigStatus,
  IntegrationDocumentValidator,
  IntegrationDomain,
  LegacyIntegrationMigrationDomainPlan,
  LegacyIntegrationMigrationPlan,
  LegacyIntegrationMigrationResult,
  McpIntegrationDocument,
} from "./common/integration-config.js";

// === 会话存储 ===
export {
  FileSessionStorage,
  type PreparedSessionAppendBaseline,
  type PreparedSessionTailDelta,
} from "./interactive/storage.js";
export { findMostRecentResumableSession } from "./session/resumable-session.js";
export {
  dedupeSessions,
  type SessionDedupeMatch,
  type SessionDedupeMove,
  type SessionDedupeOptions,
  type SessionDedupeReport,
  type SessionDedupeSkip,
  type SessionDedupeSkipReason,
} from "./session/dedupe.js";

// === Permission helpers ===
export type {
  PermissionMode,
  ConfirmResult,
  PermissionContext,
  StandaloneExecPolicyOptions,
} from "./permission/index.js";
export type {
  ReplRuntimePermissionDecision,
  ReplRuntimeAutoModeControl,
  ReplRuntimeAutoModeSettings,
  ReplRuntimePermissionGrantSuggestion,
  ReplRuntimePermissionPrompt,
  ReplRuntimePermissionRequest,
} from "./runtime-permission.js";
export { toReplRuntimeAutoModeSettings } from "./runtime-permission.js";
export { RUNTIME_PERMISSION_PENDING_NOTICE } from "./runtime-permission.js";
export {
  computeConfirmTools,
  FILE_MODIFICATION_TOOLS,
  PERMISSION_MODES,
  isPermissionMode,
  normalizePermissionMode,
  permissionModeDisplayName,
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isCommandOnProtectedPath,
  isBashReadCommand,
  isBashReadCommandAutoAllowed,
  isBashWriteCommand,
  collectBashWriteTargets,
  isPathInsideProject,
  getBashOutsideProjectWriteRisk,
  generateSavePattern,
  getPlanModeBlockReason,
  replBashPathSignalCollector,
} from "./permission/index.js";

// === Auto-mode bootstrap (v0.7.42 SDK export) ===
// FEATURE_092 auto-mode guardrail wiring. SDK consumers (KodaX Space etc.)
// now reach the same bootstrap REPL uses for the `auto` permission mode,
// instead of mirroring the internal API. See packages/repl/src/interactive/
// auto-mode-bootstrap.ts for the wiring contract.
export { bootstrapAutoMode } from "./interactive/auto-mode-bootstrap.js";
export type {
  AutoModeBootstrapDeps,
  AutoModeBootstrapResult,
  ResolvedAutoModeBootstrapSettings,
} from "./interactive/auto-mode-bootstrap.js";

// === FEATURE_173 Part B: Session Management Public SDK (v0.7.42) ===
// Also available via the `@kodax-ai/kodax/session` SDK subpath.
export type {
  SessionSummary,
  FullTranscriptSessionData,
  SessionReadCapture,
  SessionConversationHistoryData,
  SessionConversationHistoryEntry,
  SessionConversationHistoryIssue,
  SessionConversationHistoryIssueCode,
  SessionConversationHistoryStatus,
  SessionConversationMutationBoundary,
  ForkSessionOptions,
  RewindSessionOptions,
  AppendClientNoticeOptions,
  ListSessionsOptions,
  SessionTranscriptEntry,
  SessionTranscriptEntryType,
  SessionReadErrorCode,
  SessionReadOptions,
  SessionBundleExportDiagnostic,
  SessionBundleExportFile,
  SessionBundleExportOptions,
  SessionBundleExportResult,
  SessionBundleExportStatus,
  WatchSessionsCallback,
  SessionManager,
  RunningSessionInfo,
  DeleteSessionResult,
  CompactSessionOptions,
  CompactSessionResult,
} from "./session/public-api.js";
export type {
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
} from "@kodax-ai/agent";
export {
  listSessions,
  loadSession,
  loadFullTranscript,
  readFullTranscript,
  readConversationHistory,
  conversationHistoryFromCapture,
  createConversationEntryChain,
  createSessionConversationHistoryRevision,
  emptyConversationEntryChain,
  extendConversationEntryChain,
  readSessionCapture,
  exportSessionBundle,
  SessionReadError,
  ConversationPageCacheCapacityError,
  appendClientNotice,
  forkSession,
  rewindSession,
  setActiveEntry,
  deleteSession,
  archiveSession,
  unarchiveSession,
  listRunningSessions,
  watchSessions,
  createSessionManager,
  compactSession,
} from "./session/public-api.js";
