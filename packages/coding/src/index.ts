/**
 * KodaX Core
 *
 * 极致轻量化 Coding Agent Core 层
 * 可作为独立库使用，零 UI 依赖
 *
 * @example
 * ```typescript
 * import { runKodaX } from 'kodax/core';
 *
 * const result = await runKodaX(
 *   {
 *     provider: 'anthropic',
 *     context: {
 *       gitRoot: '/repo',
 *       executionCwd: '/repo/packages/app',
 *     },
 *     events: {},
 *   },
 *   "创建一个 HTTP 服务器"
 * );
 * ```
 */

// ============== Re-export from @kodax/ai ==============
// AI types are re-exported for backward compatibility
// New code should import directly from @kodax/ai

export type {
  KodaXImageBlock,
  KodaXContentBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXModelDescriptor,
  KodaXProtocolFamily,
  KodaXCustomProviderConfig,
  KodaXProviderConfig,
  KodaXProviderTransport,
  KodaXProviderConversationSemantics,
  KodaXProviderMcpSupport,
  KodaXProviderCapabilityProfile,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningOverride,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
} from '@kodax/ai';

export {
  KodaXError,
  KodaXProviderError,
  KodaXRateLimitError,
} from '@kodax/ai';

// ============== Core Types ==============

export type {
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionMeta,
  KodaXSessionScope,
  KodaXSessionRuntimeInfo,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionWorkspaceKind,
  KodaXEvents,
  ProviderRecoveryEvent,
  KodaXSessionOptions,
  KodaXContextTokenSnapshot,
  KodaXContextOptions,
  KodaXMcpTransport,
  KodaXMcpConnectMode,

  KodaXMcpServerConfig,
  KodaXMcpServersConfig,
  KodaXTaskCapabilityHint,
  KodaXTaskVerificationCriterion,
  KodaXRuntimeVerificationContract,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXSkillProjectionConfidence,
  KodaXRoleRoundSummary,
  KodaXVerificationScorecard,
  KodaXVerificationScorecardCriterion,
  KodaXBudgetExtensionRequest,
  KodaXManagedBudgetSnapshot,
  KodaXMemoryStrategy,
  KodaXBudgetDisclosureZone,
  KodaXAgentMode,
  KodaXManagedTaskStatusEvent,
  KodaXOptions,
  KodaXResult,
  KodaXTaskSurface,
  KodaXTaskStatus,
  KodaXTaskRole,
  KodaXTaskContract,
  KodaXTaskRoleAssignment,
  KodaXTaskWorkItem,
  KodaXTaskEvidenceArtifact,
  KodaXInputArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskEvidenceBundle,
  KodaXTaskToolPolicy,
  KodaXChildContextBundle,
  KodaXChildAgentResult,
  KodaXParentReductionContract,
  KodaXFanoutSchedulerInput,
  KodaXFanoutBranchLifecycle,
  KodaXFanoutBranchTransition,
  KodaXFanoutBranchRecord,
  KodaXFanoutSchedulerPlan,
  KodaXTaskVerificationContract,
  KodaXOrchestrationVerdict,
  KodaXManagedTask,
  KodaXManagedTaskRuntimeState,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXToolExecutionContext,
  AskUserQuestionOptions,
  AskUserQuestionItem,
  AskUserMultiOptions,
  KodaXProviderPolicyHints,
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTraceEvent,
  KodaXRepoIntelligenceTrace,
  SessionErrorMetadata,
} from './types.js';

// ============== Core Errors ==============

export {
  KodaXToolError,
  KodaXSessionError,
  KodaXTerminalError,
} from './errors.js';

// ============== Error Classification ==============

export {
  classifyError,
  ErrorCategory,
} from './error-classification.js';

export type {
  ErrorClassification,
} from './error-classification.js';

// ============== Constants ==============

export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
  CANCELLED_TOOL_RESULT_PREFIX,
  CANCELLED_TOOL_RESULT_MESSAGE,
} from './constants.js';

// ============== Provider (re-export from @kodax/ai) ==============

export {
  KodaXBaseProvider,
  KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider,
  KODAX_PROVIDERS,
  KODAX_PROVIDER_SNAPSHOTS,
  KODAX_DEFAULT_PROVIDER,
  getProvider,
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  isProviderConfigured,
  getProviderModel,
  getProviderModels,
  getProviderList,
  isProviderName,
  buildReasoningOverrideKey,
  loadReasoningOverride,
  saveReasoningOverride,
  clearReasoningOverride,
  reasoningCapabilityToOverride,
  reasoningOverrideToCapability,
  createCustomProvider,
  registerCustomProviders,
  getCustomProvider,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderList,
  getCustomProviderModels,
  registerModelProvider,
  getRuntimeModelProvider,
  isRuntimeModelProviderName,
  getRuntimeModelProviderNames,
  clearRuntimeModelProviders,
  resolveProvider,
  isKnownProvider,
  getAvailableProviderNames,
} from './providers/index.js';
export type { ProviderName } from './providers/index.js';

// ============== Tools ==============

export {
  type ToolHandler,
  type ToolRegistry,
  type LocalToolDefinition,
  type RegisteredToolDefinition,
  type ToolDefinitionSource,
  type ToolRegistrationOptions,
  type KodaXRetrievalToolName,
  type KodaXRetrievalScope,
  type KodaXRetrievalTrust,
  type KodaXRetrievalFreshness,
  type KodaXRetrievalArtifact,
  type KodaXRetrievalItem,
  type KodaXRetrievalResult,
  KODAX_TOOLS,
  registerTool,
  getTool,
  getToolDefinition,
  getRegisteredToolDefinition,
  getToolRegistrations,
  getBuiltinToolDefinition,
  getBuiltinRegisteredToolDefinition,
  createBuiltinToolDefinition,
  listBuiltinToolDefinitions,
  getRequiredToolParams,
  listTools,
  listToolDefinitions,
  executeTool,
  toolRead,
  toolWrite,
  toolEdit,
  toolInsertAfterAnchor,
  toolBash,
  toolGlob,
  toolGrep,
  toolUndo,
  toolAskUserQuestion,
  toolRepoOverview,
  toolChangedScope,
  toolChangedDiff,
  toolModuleContext,
  toolSymbolContext,
  toolProcessContext,
  toolImpactEstimate,
  toolWebSearch,
  toolWebFetch,
  toolCodeSearch,
  toolSemanticLookup,
  stripHtmlToText,
  extractHtmlTitle,
  renderRetrievalResult,
  finalizeRetrievalResult,
  convertProviderSearchResults,
  convertCapabilityReadResult,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  READ_DEFAULT_LIMIT,
  READ_PREFLIGHT_SIZE_BYTES,
  READ_MAX_LINE_CHARS,
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
  persistToolOutput,
  applyToolResultGuardrail,
  getToolResultPolicy,
  inspectEditFailure,
  parseEditToolError,
} from './tools/index.js';

export type {
  EditRecoveryDiagnostic,
  EditToolErrorCode,
} from './tools/index.js';

// ============== Repo Intelligence ==============

export type {
  RepoAreaKind,
  ChangedFileStatus,
  RepoAreaOverview,
  RepoOverview,
  ChangedScopeAreaSummary,
  ChangedFileEntry,
  ChangedScopeReport,
} from './repo-intelligence/index.js';

export {
  buildRepoOverview,
  getRepoOverview,
  buildRepoIntelligenceContext,
  renderRepoOverview,
  analyzeChangedScope,
  renderChangedScope,
} from './repo-intelligence/index.js';

export type {
  RepoLanguageId,
  LanguageCapabilityTier,
  RepoLanguageSupport,
  RepoSymbolKind,
  RepoSymbolReference,
  RepoSymbolRecord,
  ModuleCapsule,
  ProcessStep,
  ProcessCapsule,
  RepoIntelligenceIndex,
  ModuleContextResult,
  SymbolContextResult,
  ProcessContextResult,
  ImpactEstimateResult,
} from './repo-intelligence/query.js';

export type {
  KodaXRepoRoutingSignals,
} from './types.js';

export {
  buildRepoIntelligenceIndex,
  getRepoIntelligenceIndex,
  getRepoRoutingSignals,
  getModuleContext,
  getSymbolContext,
  getProcessContext,
  getImpactEstimate,
} from './repo-intelligence/runtime.js';

export type {
  RepoIntelligenceRuntimeInspection,
  RepoIntelligenceRuntimeWarmResult,
} from './repo-intelligence/premium-client.js';

export {
  resolveRepoIntelligenceRuntimeConfig,
  resolveRepoIntelligenceMode,
  inspectRepoIntelligenceRuntime,
  warmRepoIntelligenceRuntime,
} from './repo-intelligence/premium-client.js';

export {
  REPOINTEL_DEFAULT_ENDPOINT,
} from '@kodax/repointel-protocol';

export {
  renderModuleContext,
  renderSymbolContext,
  renderProcessContext,
  renderImpactEstimate,
} from './repo-intelligence/query.js';

// ============== Prompts ==============

export {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildSystemPromptSnapshot,
  PROMPT_SECTION_REGISTRY,
  buildPromptSnapshot,
  createPromptSection,
  orderPromptSections,
  renderPromptSections,
} from './prompts/index.js';
export type {
  KodaXPromptSectionSlot,
  KodaXPromptSectionStability,
  KodaXPromptSectionDefinition,
  KodaXPromptSection,
  KodaXPromptSnapshotMetadata,
  KodaXPromptSnapshot,
} from './prompts/index.js';

// ============== Session ==============

export {
  generateSessionId,
  extractTitleFromMessages,
  appendSessionLineageLabel,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  findPreviousUserEntryId,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './session.js';

// ============== Message Processing ==============

export {
  extractArtifactLedger,
  mergeArtifactLedger,
  type CompactionAnchor,
  type CompactionUpdate,
  checkIncompleteToolCalls,
} from './messages.js';

export {
  buildPromptMessageContent,
  extractComparableUserMessageText,
  extractPromptComparableText,
} from './input-artifacts.js';

// ============== Tokenizer ==============

export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';

// ============== Agent ==============

export {
  runKodaX,
  checkPromiseSignal,
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './agent.js';

// FEATURE_093 (v0.7.24): KodaXClient imported directly from client.ts to
// avoid re-creating the agent ↔ client cycle at the barrel.
export { KodaXClient } from './client.js';

export {
  buildFanoutSchedulerPlan,
  createFanoutSchedulerInput,
  applyFanoutBranchTransition,
  countActiveFanoutBranches,
  getFanoutBranch,
  assignFanoutBranchWorker,
  markFanoutBranchCompleted,
  markFanoutBranchCancelled,
} from './fanout-scheduler.js';

export {
  runManagedTask,
} from './task-engine.js';

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
  OfficialSandboxMode,
  OfficialSandboxOptions,
} from './extensions/index.js';

export {
  KodaXExtensionRuntime,
  createExtensionRuntime,
  setActiveExtensionRuntime,
  getActiveExtensionRuntime,
  registerConfiguredMcpCapabilityProvider,
  registerOfficialSandboxExtension,
} from './extensions/index.js';

// ============== Orchestration ==============
export {
  runOrchestration,
  createKodaXTaskRunner,
} from './orchestration.js';

export type {
  OrchestrationTaskExecution,
  OrchestrationTaskStatus,
  OrchestrationTaskBudget,
  OrchestrationArtifact,
  OrchestrationWorkerSpec,
  OrchestrationWorkerResult,
  OrchestrationCompletedTask,
  OrchestrationTaskContext,
  OrchestrationWorkerRunner,
  OrchestrationTraceEvent,
  OrchestrationRunEvents,
  OrchestrationRunOptions,
  OrchestrationRunResult,
  KodaXAgentWorkerSpec,
  CreateKodaXTaskRunnerOptions,
} from './orchestration.js';

// ============== Parallel Dispatch ==============
export {
  isParallelDispatchDirective,
  formatParallelDispatchResult,
  validateSubtaskIndependence,
} from './parallel-dispatch.js';

export type {
  ParallelSubtask,
  ParallelDispatchDirective,
  ParallelDispatchResult,
} from './parallel-dispatch.js';

// ============== Reasoning ==============
export {
  KODAX_REASONING_MODE_SEQUENCE,
  resolveReasoningMode,
  reasoningModeToDepth,
  inferTaskType,
  buildAmaControllerDecision,
  buildFallbackRoutingDecision,
  buildProviderPolicyHintsForDecision,
  buildPromptOverlay,
  createReasoningPlan,
} from './reasoning.js';

export type {
  KodaXProviderCapabilitySnapshot,
  KodaXProviderPolicyDecision,
  KodaXProviderPolicyIssue,
  KodaXProviderPolicyIssueSeverity,
  KodaXProviderSourceKind,
} from './provider-policy.js';

export {
  buildProviderCapabilitySnapshot,
  buildProviderPolicyPromptNotes,
  evaluateProviderPolicy,
} from './provider-policy.js';

// Client alias
export { KodaXClient as Client } from './client.js';

// ============== Permissions ==============
export {
  classifyBashCommand,
  createBashClassifierConfig,
  DEFAULT_SAFE_PATTERNS,
  DEFAULT_DANGEROUS_PATTERNS,
} from './permissions/bash-classifier.js';
export type {
  BashRiskLevel,
  BashClassificationResult,
  BashClassifierConfig,
} from './permissions/bash-classifier.js';

export {
  createDenialTracker,
  recordDenial,
  isDeniedRecently,
  getDenialContext,
  computeInputSignature,
} from './permissions/denial-tracker.js';
export type { DenialRecord, DenialTracker } from './permissions/denial-tracker.js';

// ============== Context Loaders ==============

export {
  loadAgentsFiles,
  formatAgentsForPrompt,
  getKodaxGlobalDir,
} from './context/agents-loader.js';

export type {
  AgentsFile,
  LoadAgentsOptions,
} from './context/agents-loader.js';


// ============== Resilience (Feature 045) ==============
export type {
  ResilienceErrorClass,
  FailureStage,
  RecoveryAction,
  RecoveryLadderStep,
  ResilienceClassification,
  ProviderExecutionState,
  RecoveryDecision,
  RecoveryResult,
  ProviderResilienceConfig,
  ProviderResiliencePolicy,
} from './resilience/types.js';

export {
  DEFAULT_RESILIENCE_CONFIG,
  resolveResilienceConfig,
} from './resilience/config.js';

export {
  classifyResilienceError,
} from './resilience/classifier.js';

export {
  StableBoundaryTracker,
} from './resilience/stable-boundary.js';

export {
  ProviderRecoveryCoordinator,
} from './resilience/recovery-coordinator.js';

export {
  reconstructMessagesWithToolGuard,
} from './resilience/tool-guard.js';

// ============== Extension Helpers ==============
export { exec, webhook } from './extensions/helpers.js';

// ============== Layer A Primitives (FEATURE_080 + FEATURE_081, v0.7.23, @experimental) ==============
// These types & classes are migrating to @kodax/core in v0.7.24 (FEATURE_082).
// FEATURE_082 (v0.7.24): Layer A primitives moved to `@kodax/core`. These
// barrel re-exports preserve the batteries-included shape of @kodax/coding
// — not a deprecation shim, they stay permanently.
//
// The Option-Y dog-food registers the default coding dispatcher as a side
// effect of importing `./coding-preset.js`.

export type {
  Agent,
  AgentMessage,
  AgentReasoningProfile,
  AgentTool,
  Guardrail,
  Handoff,
  ReasoningDepth,
  InMemorySessionOptions,
  MessageEntry,
  Session,
  SessionEntry,
  SessionExtension,
  SessionForkOptions,
  CompactionContext,
  CompactionEntry,
  CompactionEntryPayload,
  CompactionPolicy,
  CompactionResult,
  DefaultSummaryCompactionOptions,
  PresetDispatcher,
  RunEvent,
  RunOptions,
  RunResult,
} from '@kodax/core';

export {
  createAgent,
  createHandoff,
  createInMemorySession,
  DefaultSummaryCompaction,
  Runner,
  registerPresetDispatcher,
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  EVALUATOR_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  scoutAgent,
  plannerAgent,
  generatorAgent,
  evaluatorAgent,
} from '@kodax/core';

export {
  DEFAULT_CODING_AGENT_NAME,
  createDefaultCodingAgent,
} from './coding-preset.js';

// FEATURE_084 Shard 2 (v0.7.26): protocol emitter tools + coding Agent
// instances with handoff topology. Data-only at this shard; consumed by the
// Runner-driven task engine in Shard 5.
export {
  CODING_AGENT_MARKER,
  CODING_AGENTS,
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_HANDOFF_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
  evaluatorCodingAgent,
  generatorCodingAgent,
  plannerCodingAgent,
  scoutCodingAgent,
} from './agents/index.js';
export type { ProtocolEmitterMetadata } from './agents/index.js';

// FEATURE_085 (v0.7.26): adapter wrapping the legacy per-tool truncation
// policy as a Layer A ToolGuardrail.afterTool. Opt-in — the SA preset path
// continues to call applyToolResultGuardrail directly.
export {
  TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME,
  createToolResultTruncationGuardrail,
} from './tools/tool-result-truncation-guardrail.js';

// FEATURE_082 (v0.7.24): LineageExtension and LineageCompaction moved to
// `@kodax/session-lineage`. Barrel re-export kept for
// batteries-included consumers; not a deprecation shim.
export type {
  LineageArtifactLedgerPayload,
  LineageEntryType,
  LineageLabelPayload,
  LineageTreeNode,
  LineageCompactionDelegates,
} from '@kodax/session-lineage';

export { LINEAGE_ENTRY_TYPES, LineageExtension, LineageCompaction } from '@kodax/session-lineage';

// NOTE: `KodaXSessionLineage` is exported above (line ~90) alongside the
// legacy session types. As of FEATURE_081 (v0.7.23) it is superseded by
// `Session` + `LineageExtension`; scheduled for removal in FEATURE_086
// (v0.7.27) alongside the `KodaX*` prefix cleanup.
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './extensions/helpers.js';

// FEATURE_082 (v0.7.24): MCP provider moved to `@kodax/mcp`. Barrel
// re-export kept for batteries-included consumers; not a deprecation shim.
export type {
  McpServerConfig,
  McpServersConfig,
  McpTransportKind,
  McpConnectMode,
  McpCapabilityKind,
  McpCapabilityRisk,
  McpCatalogItem,
  McpCapabilityDescriptor,
  McpServerCatalogSnapshot,
  McpServerRuntimeDiagnostics,
  McpProviderOptions,
  McpTransport,
  McpTransportEvents,
} from '@kodax/mcp';
export {
  McpCapabilityProvider,
  McpServerRuntime,
  createMcpTransport,
  defaultMcpCacheDir,
  createMcpCapabilityId,
  parseMcpCapabilityId,
  searchMcpCatalog,
  getMcpCachePaths,
} from '@kodax/mcp';

// FEATURE_087 + FEATURE_088 (v0.7.28): Construction Runtime — runtime-
// generated tools / agents / skills. v0.7.28 ships tool generation only.
export type {
  ConstructionArtifact,
  ArtifactStatus,
  Capabilities,
  ConstructionPolicy,
  ConstructionPolicyVerdict,
  ScriptSource,
  StagedHandle,
  TestResult,
  ToolContent,
  LoadHandlerOptions,
  LoadHandlerScope,
  CreateCtxProxyOptions,
  // Phase 2 static-check pipeline
  AstCheckResult,
  AstRuleId,
  AstRuleViolation,
  SchemaProvider,
  SchemaValidationResult,
  BuildPromptInput,
  LlmReviewClient,
  LlmReviewResult,
  LlmReviewVerdict,
  TestArtifactOptions,
} from './construction/index.js';

export {
  CapabilityDeniedError,
  ConstructionManifestError,
  DEFAULT_HANDLER_TIMEOUT_MS,
  defaultPolicy,
  configureRuntime,
  stage,
  testArtifact,
  activate,
  revoke,
  listArtifacts,
  readArtifact,
  rehydrateActiveArtifacts,
  listConstructed,
  findByVersion,
  listAll,
  loadHandler,
  createCtxProxy,
  // Phase 2 static-check pipeline
  runAstRules,
  validateToolSchemaForProvider,
  buildLlmReviewPrompt,
  parseLlmReviewVerdict,
  runLlmReview,
} from './construction/index.js';
