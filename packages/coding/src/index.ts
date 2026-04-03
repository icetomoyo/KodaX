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
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionMeta,
  KodaXSessionScope,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXEvents,
  KodaXSessionOptions,
  KodaXContextTokenSnapshot,
  KodaXContextOptions,
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
  KodaXProviderPolicyHints,
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
  KODAX_COMPACT_THRESHOLD,
  KODAX_COMPACT_KEEP_RECENT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
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
  renderModuleContext,
  renderSymbolContext,
  renderProcessContext,
  renderImpactEstimate,
} from './repo-intelligence/query.js';

// ============== Prompts ==============

export {
  SYSTEM_PROMPT,
  LONG_RUNNING_PROMPT,
  buildSystemPrompt,
} from './prompts/index.js';

// ============== Session ==============

export {
  generateSessionId,
  extractTitleFromMessages,
  appendSessionLineageLabel,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  setSessionLineageActiveEntry,
} from './session.js';

// ============== Message Processing ==============

export {
  compactMessages,
  checkIncompleteToolCalls,
} from './messages.js';

// ============== Tokenizer ==============

export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';

// ============== Agent ==============

export {
  runKodaX,
  checkPromiseSignal,
  KodaXClient,
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './agent.js';

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
} from './extensions/index.js';

export {
  KodaXExtensionRuntime,
  createExtensionRuntime,
  setActiveExtensionRuntime,
  getActiveExtensionRuntime,
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
