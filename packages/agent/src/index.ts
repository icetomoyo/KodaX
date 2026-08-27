/**
 * @kodax-ai/agent
 *
 * 通用 Agent 框架 - 会话管理和消息处理
 *
 * 这个包提供了通用的 Agent 功能：
 * - 会话 ID 生成和标题提取
 * - Token 估算
 * - 消息压缩
 * - 通用常量配置
 */

// ============== Types ==============
export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  // v0.7.35.1 FEATURE_142 (A-R4): KodaXHarnessProfile / KodaXChildFanoutClass
  // are coding-routing vocabulary; the canonical home is `@kodax-ai/llm`.
  // Removed from `@kodax-ai/agent`'s public re-export per ADR-021 (the
  // universal Agent framework must not expose coding-routing terms in its
  // surface). Coding-side consumers import directly from `@kodax-ai/llm`.
  // (The AMA-controller advisory types were deleted in ADR-043.)
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXGoalEventType,
  KodaXGoalState,
  KodaXGoalStatus,
  KodaXMemoryIntent,
  KodaXMemoryOutcomeDigest,
  KodaXHandledMemoryOperation,
  KodaXMemoryOutcomeEvidence,
  KodaXMemoryInfluenceRef,
  KodaXSessionArchiveMarkerEntry,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionClientNoticeEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionGoalEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionMemoryOutcomeDigestEntry,
  KodaXSessionMemoryReviewReceiptEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionRewindMarkerEntry,
  KodaXSessionMeta,
  KodaXSessionScope,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
} from './types.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from './constants.js';

// ============== Tokenizer ==============
export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';
export {
  CONTEXT_SAFETY_FLOOR_TOKENS,
  CONTEXT_SAFETY_RATIO,
  ContextCapacityError,
  calculateContextSafetyMargin,
  calculateMaxContextInputTokens,
  exceedsContextCapacity,
  reclaimReservedResponseTokens,
  RESERVE_SHRINK_FLOOR_TOKENS,
  type ContextCapacityInput,
} from './context-capacity.js';

// ============== Diagnostics ==============
export {
  emitKodaXDiagnostic,
  formatKodaXDiagnostic,
  setKodaXDiagnosticSink,
} from './diagnostics.js';
export type {
  KodaXDiagnostic,
  KodaXDiagnosticLevel,
  KodaXDiagnosticSink,
} from './diagnostics.js';

// ============== Session entities + persistence + compaction implementations ==============
// v0.7.35.1 FEATURE_142 Batch B: session.ts / session-lineage.ts / persistence.ts /
// compaction/ moved from @kodax-ai/agent to ./session-lineage/index.js. Consumers should
// `import ... from './session-lineage/index.js'` directly. @kodax-ai/agent stays as the
// pure Agent platform foundation (primitives + admission + tokenizer + types);
// session implementation, persistence, and compaction orchestration live in
// ./session-lineage/index.js. See ADR-021 + docs/features/v0.7.35.1.md.
//
// Symbols moved (NOT re-exported here to keep the agent → session-lineage
// dependency direction unidirectional, avoiding a cycle):
//   - generateSessionId, extractTitleFromMessages
//   - KodaXSessionLineage operations (createSessionLineage / applySessionCompaction /
//     forkSessionLineage / rewindSessionLineage / buildSessionTree / …)
//   - FileExtensionStore, createExtensionStore
//   - CompactionConfig + needsCompaction / compact / microcompact / post-compact / …
//   - CompactionAnchor / CompactionDetails / CompactionUpdate / CompactionResult /
//     FileOperations / KodaXCompactionPromptSnapshot / …

// ============== Layer A Primitives (absorbed from @kodax-ai/core in v0.7.35.1 FEATURE_142) ==============
// FEATURE_082 (v0.7.24) extracted these into @kodax-ai/core; v0.7.35.1 FEATURE_142
// merges them back into @kodax-ai/agent because:
// - @kodax-ai/core had a single consumer (@kodax-ai/coding); 3+ rule violation
// - @kodax-ai/agent IS the agent platform foundation, primitives belong here
// See ADR-001 (updated) / ADR-021 / docs/features/v0.7.35.1.md.

// Agent + Handoff
export type {
  Agent,
  AgentMessage,
  AgentMiddlewareDeclaration,
  AgentReasoningProfile,
  AgentTool,
  Guardrail,
  Handoff,
  ReasoningDepth,
} from './primitives/agent.js';
export { createAgent, createHandoff } from './primitives/agent.js';

// Base Session interface (the @experimental thick KodaXSessionLineage at root
// stays as the coding-preset session implementation; this is the Layer A
// primitive that LineageExtension is composed over)
export type {
  InMemorySessionOptions,
  MessageEntry,
  Session,
  SessionEntry,
  SessionExtension,
  SessionForkOptions,
} from './primitives/session.js';
export { createInMemorySession } from './primitives/session.js';

// CompactionPolicy + DefaultSummaryCompaction
// Note: `PolicyCompactionResult` is the Layer A primitive type (renamed from
// `CompactionResult` in v0.7.35.1 FEATURE_142 to disambiguate from agent's
// pre-existing `CompactionResult` in compaction/types.ts).
export type {
  CompactionContext,
  CompactionEntry,
  CompactionEntryPayload,
  CompactionPolicy,
  PolicyCompactionResult,
  DefaultSummaryCompactionOptions,
} from './primitives/compaction.js';
export { DefaultSummaryCompaction } from './primitives/compaction.js';

// Runner + run loop
export type {
  PresetDispatcher,
  PresetTracingContext,
  RunEvent,
  RunOptions,
  RunResult,
  RunnerRecoveryTranscriptCarrier,
  StopHookContext,
  StopHookFn,
  StopHookResult,
} from './primitives/runner.js';
export {
  Runner,
  RunnerIterationLimitError,
  attachRunnerRecoveryTranscript,
  buildSystemPrompt,
  registerPresetDispatcher,
  _resetPresetDispatchers,
  extractAssistantTextFromMessage,
  isRunnerIterationLimitError,
  readRunnerRecoveryTranscript,
} from './primitives/runner.js';

export type {
  RunnableTool,
  RunnerLlmResult,
  RunnerLlmReturn,
  RunnerToolCall,
  RunnerToolContext,
  RunnerToolObserver,
  RunnerToolResult,
  RunnerToolResultBatch,
  RunnerToolResultBatchTransform,
} from './primitives/runner-tool-loop.js';
export {
  MAX_TOOL_LOOP_ITERATIONS,
  buildAssistantMessageFromLlmResult,
  buildToolResultMessage,
  executeRunnerToolCall,
  isRunnableTool,
  isRunnerLlmResult,
} from './primitives/runner-tool-loop.js';

export type {
  HandoffSignal,
} from './primitives/runner-handoff.js';
export {
  detectHandoffSignal,
  emitHandoffSpan,
  replaceSystemMessage,
} from './primitives/runner-handoff.js';

// Guardrail tri-layer
export type {
  GuardrailContext,
  GuardrailPermissionIntent,
  GuardrailVerdict,
  InputGuardrail,
  OutputGuardrail,
  ToolBeforeOutcome,
  ToolGuardrail,
} from './primitives/guardrail.js';
export {
  GuardrailBlockedError,
  GuardrailEscalateError,
  collectGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
} from './primitives/guardrail.js';

// v0.7.35.1 FEATURE_142 (A-R1): SCOUT_AGENT_NAME / PLANNER_AGENT_NAME /
// GENERATOR_AGENT_NAME / EVALUATOR_AGENT_NAME / TASK_ENGINE_ROLE_AGENTS /
// scoutAgent / plannerAgent / generatorAgent / evaluatorAgent moved out of
// @kodax-ai/agent. These role declarations are coding-AMA-specific (H2 state
// machine roles), not generic Agent platform primitives. Canonical home is
// now `@kodax-ai/coding/src/agents/task-engine-agents.ts`. Coding-side
// consumers import from `@kodax-ai/coding`. See ADR-021.

// ============== Admission Contract (FEATURE_101 v0.7.31; absorbed from @kodax-ai/core in v0.7.35.1) ==============
export type {
  AdmissionCtx,
  AdmissionVerdict,
  AdmittedHandle,
  AgentManifest,
  Deliverable,
  InvariantId,
  InvariantResult,
  ManifestPatch,
  ObserveCtx,
  QualityInvariant,
  ReadonlyMutationTracker,
  ReadonlyRecorder,
  RunnerEvent,
  SystemCap,
  TerminalCtx,
  ToolCapability,
  ToolPermission,
} from './admission/admission.js';

export {
  _resetInvariantRegistry,
  applyManifestPatch,
  composePatches,
  getInvariant,
  listRegisteredInvariants,
  registerInvariant,
  resolveEffectiveInvariants,
  resolveRequiredInvariants,
} from './admission/admission-runtime.js';

export type { AdmissionAuditOptions } from './admission/admission-audit.js';
export {
  DEFAULT_SYSTEM_CAP,
  runAdmissionAudit,
  detectInstructionsInjection,
} from './admission/admission-audit.js';

export type { SessionDispatchResult } from './admission/admission-session.js';
export {
  InvariantSession,
  createInvariantSessionForAgent,
  getAdmittedAgentBindings,
  setAdmittedAgentBindings,
  _resetAdmittedAgentBindings,
} from './admission/admission-session.js';

export type { AdmissionMetricsSnapshot } from './admission/admission-metrics.js';
export {
  _resetAdmissionMetrics,
  getAdmissionMetricsSnapshot,
  isAdmissionDebugEnabled,
} from './admission/admission-metrics.js';

// FEATURE_101 v1 pure-new invariants
// v0.7.35.1 FEATURE_142 (A-R2): `harnessSelectionTiming` moved to
// `@kodax-ai/coding/src/agent-runtime/invariants/` — its body reads coding's
// AMA Scout-role `confirmedHarness` field, see ADR-021.
export {
  CORE_INVARIANTS,
  evidenceTrail,
  finalOwner,
  handoffLegality,
  registerCoreInvariants,
} from './admission/invariants/index.js';

// Capability provider contract — re-exported from @kodax-ai/llm (canonical home
// per ADR-021). Re-export here lets v0.7.35 consumers that imported these
// types from @kodax-ai/core continue to work via @kodax-ai/agent without splitting
// the import. Direct import from @kodax-ai/llm is also supported.
export type {
  CapabilityCache,
  CapabilityCacheEntry,
  CapabilityCacheSource,
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
  CapabilitySearchFailure,
  CapabilitySearchFreshness,
  CapabilitySearchOptions,
  CapabilitySearchSnapshot,
} from '@kodax-ai/llm';

// ============== Agent config home resolver (v0.7.35.1 FEATURE_145) ==============
// 3-tier resolution chain (programmatic override > KODAX_HOME env > ~/.kodax
// default) to centralize ~30 hardcoded `path.join(homedir(), '.kodax', ...)`
// callsites previously scattered across coding / mcp / repl / session-lineage
// / skills. With DI not set + env not set, the resolver returns the same
// path as the prior hardcoded calls — byte-equivalent for existing users.
// Substrate consumers (downstream agents built on @kodax-ai/agent) call
// setAgentConfigHome() once at boot to redirect the entire process.
export {
  getAgentConfigHome,
  getAgentConfigPath,
  setAgentConfigHome,
  getAppDataDir,
  isPathInsideDirectory,
  resolveExecutionPath,
} from './runtime/agent-home.js';

export {
  CAPABILITY_CACHE_FILENAME,
  clearCapabilityCache,
  getCachedRejectedEfforts,
  getCapabilityCacheFile,
  loadCapabilityCache,
  recordRejectedEffort,
  resetCapabilityCacheMemoForTesting,
} from './runtime/capability-cache.js';

// FEATURE_208 (v0.7.45): process hardening (debug-preserving subset).
export {
  applyProcessHardening,
  prepareJavaScriptChildLaunch,
  prepareInternalNodeLaunch,
  stripHardenedEnvVars,
  ELECTRON_NODE_ENV_SCRUB_IMPORT,
  ELECTRON_RUN_AS_NODE_ENV,
  BUN_BE_BUN_ENV,
  HARDENED_ENV_VARS,
  HARDENING_OPT_OUT_ENV,
  type InternalNodeLaunch,
  type JavaScriptChildLaunch,
  type PrepareInternalNodeLaunchOptions,
  type PrepareJavaScriptChildLaunchOptions,
} from './runtime/process-hardening.js';

export {
  isChildProcessExited,
  waitForChildProcessExit,
  killChildProcessTree,
  killChildProcessTreeSync,
  killPidTree,
  killPidTreeSync,
  isCurrentProcessWindowsJobContained,
  readProcessStartIdentity,
  rememberChildProcessTree,
  type ProcessTreeKillResult,
  type ProcessTreeKillStatus,
  type ProcessTreeKillOptions,
} from './runtime/process-tree.js';

export {
  registerManagedChildProcess,
  cleanupRegisteredManagedChildren,
  type ManagedChildRegistrationOptions,
  type ManagedChildProcessMetadata,
  type ManagedChildCleanupSummary,
} from './runtime/managed-child-processes.js';

export {
  containWindowsEffectProcess,
  terminateWindowsEffectJob,
  windowsSandboxSidHasActiveProcesses,
  windowsSandboxSidHasOtherProcesses,
  type WindowsEffectJob,
  type WindowsSandboxSidProbeLauncher,
} from './runtime/windows-effect-job.js';

// FEATURE_222 — user-interaction primitive (shared by coding ask_user_* tools
// and the agent MCP elicitation reverse capability) + the live-surface registry.
export type {
  UserInteraction,
  UserInteractionPromptContext,
  AskUserAnswer,
  AskUserSelectionAnswer,
  AskUserCustomInputAnswer,
  AskUserQuestionItem,
  AskUserMultiOptions,
  AskUserQuestionOptions,
} from './runtime/user-interaction.js';
export {
  setActiveUserInteraction,
  getActiveUserInteraction,
  ASK_USER_BACK_SIGNAL,
  ASK_USER_CUSTOM_INPUT_SIGNAL,
  asSingleSelection,
  isAskUserCustomInputAnswer,
} from './runtime/user-interaction.js';

// ============== Messaging (v0.7.36 FEATURE_115) ==============
// agentId-scoped 2-tier priority queue infrastructure. Generic agent-platform
// primitive per ADR-021 — downstream consumers in @kodax-ai/coding (runner-driven
// mid-turn drain, subagent task-notification routing) and @kodax-ai/repl
// (FEATURE_111 absorbed soft-pause UX). Phase 0.6 study (claude-code-actual-
// usage.md) showed Claude Code's `'now'` priority has zero production usage,
// so KodaX simplifies to 2 tiers.
export type {
  DequeueFilter,
  EnqueueInput,
  MaybeDrainMidTurnInput,
  MessageDelivery,
  MessageMode,
  MessagePriority,
  QueuedInputArtifact,
  QueuedMessage,
} from './messaging/index.js';
export {
  MessageQueue,
  YIELD_TOOL_NAMES,
  _resetActiveRootQueueRoutesForTests,
  _resetMessageQueueForTests,
  actorQueueId,
  createRuntimeDeliveryPredicate,
  getMessageQueue,
  maybeDrainMidTurn,
  midTurnDrainPriority,
  registerActiveRootQueueRoute,
  resolveActiveRootQueueRoute,
} from './messaging/index.js';

// ============== Media / input artifacts ==============
// Generic artifact construction, validation, and enqueue helpers. Coding keeps
// compatibility re-exports, but the canonical layer is agent because queued
// multimodal input is not coding-specific.
export * from './media/index.js';

// ============== Orchestration (v0.7.39 FEATURE_120 Step 0) ==============
// Generic fan-out / idle-yield / steering primitives lifted from
// `@kodax-ai/coding`'s task-engine internals so the agent framework can
// be consumed standalone (ADR-021). Coding-flavor specifics
// (`KodaXChildExecutionResult` shape, AGENTS.md injection, etc.) stay
// in `@kodax-ai/coding` and consume these as generics.
export type {
  EnvelopeAggregateEnforcer,
  EnvelopeAggregateCapacityContext,
  FanOutOutcome,
  FanOutProgressEvent,
  IdleYieldSnapshot,
  RunFanOutOptions,
  RunFanOutResult,
  RunWithIdleYieldOptions,
  RunWithIdleYieldRunResult,
  WaitForWakeEventOptions,
  WakeEvent,
} from './orchestration/index.js';
export {
  DEFAULT_IDLE_YIELD_MAX_ITERATIONS,
  composeIdleYieldUserMessage,
  countLastAssistantToolCalls,
  detectIdleYield,
  isIdleYieldEnabled,
  QueuedInputArtifactError,
  runFanOut,
  runWithIdleYield,
  waitForWakeEvent,
} from './orchestration/index.js';

// ============== Team Mode — multi-instance coordination (v0.7.41 FEATURE_125) ==============
// State broadcast primitives let sibling KodaX sessions discover each other
// and inject each other's intent / active files into worker system prompts.
// Generic agent-platform machinery per ADR-021 — usable by any downstream
// agent that wants multi-instance awareness, not coding-specific.
export type {
  CurrentTodoSummary,
  PersistedSessionState,
  RecentlyModifiedFile,
  SessionMeta,
  SessionStateSnapshot,
  StateWriter,
  StateWriterFs,
  StateWriterOptions,
} from './team/state-writer.js';
export { createStateWriter } from './team/state-writer.js';
export type {
  DiscoveredInstance,
  DiscoveryOptions,
  InstanceDiscoveryFs,
} from './team/instance-discovery.js';
export { discoverInstances } from './team/instance-discovery.js';
export type { RenderOptions } from './team/system-prompt-injection.js';
export { buildOtherInstancesPromptBlock } from './team/system-prompt-injection.js';
export type { TeamModeBootstrapOptions, TeamModeHandle } from './team/bootstrap.js';
export { bootstrapTeamMode } from './team/bootstrap.js';
export {
  getActiveTeamModeWriter,
  setActiveTeamModeWriter,
  updateActiveTeamMode,
} from './team/active-team-mode.js';

// ============== Runtime middleware (v0.7.35.1 FEATURE_142 Batch D) ==============
// Generic, agent-flavor-agnostic substrate middleware uplifted from
// `@kodax-ai/coding/src/agent-runtime/`. Per the narrowed Batch D scope, only
// modules whose deps are pure `@kodax-ai/llm` (+ this package's own tokenizer)
// are uplifted; the rest stay in @kodax-ai/coding because they couple to
// coding-flavored events / tool registry / managed protocol signals. See
// docs/features/v0.7.35.1.md "Batch D" for per-file disposition.
//
// v0.7.36 follow-up: the three compaction-related modules (`shouldCompact`,
// `gracefulCompactDegradation`, `resolveContextWindow` + `DEFAULT_CONTEXT_WINDOW`
// / `ShouldCompactInput`) moved to `./session-lineage/index.js/runtime-middleware/`
// to break the build cycle (agent → session-lineage → agent) introduced
// when they were originally placed here. Downstream consumers in
// `@kodax-ai/coding` now import them from `./session-lineage/index.js` directly.
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './runtime-middleware/index.js';

// FEATURE_215 (v0.7.49) — Generic LLM-judged stop-hook primitive.
// Domain-neutral consult kernel shared by coding's Sidecar Verifier +
// Stall Sidecar; exposed for external SDK consumers on a bare `Runner`.
export {
  editDistance,
  findFuzzyToolMatch,
  invokeLlmJudge,
  createLlmJudgedStopHook,
} from './runtime-middleware/index.js';
export type {
  LlmJudgeFailureReason,
  InvokeLlmJudgeOptions,
  CreateLlmJudgedStopHookOptions,
} from './runtime-middleware/index.js';

// FEATURE_124 (v0.7.43) — Memory System Alignment substrate.
// Per-project memory directory + frontmatter taxonomy + claudecode-shape
// truncation. Consumed by `@kodax-ai/coding` SP builder (Phase B/C) and
// `@kodax-ai/repl` `/memory` slash + transcript badge (Phase D).
export * from './memory/index.js';

// FEATURE_228 (v0.7.62) - Unified memory control plane + governance.
// Iterates on FEATURE_224 by projecting memory handoffs from the existing
// learning proposal store into typed refs, guarded approvals, and memory packs.
export * from './memory-control/index.js';

// FEATURE_224 (v0.7.54) - Procedural learning triage + SkillCurator v1
// substrate. Owns learning intake, skill governance, and safe skill proposal
// apply primitives; workflow and memory mutation remain destination-specific.
export type {
  ApproveStoredLearningProposalOptions,
  CompletedTurnLearningCandidate,
  CompletedTurnLearningInput,
  CompletedTurnLearningRecordResult,
  DiscardedLearningReport,
  GovernedSkillSource,
  LearningCandidate,
  LearningIntakeRecordResult,
  LearningProposalReviewStatus,
  LearningProposalStoreReadResult,
  LearningRisk,
  LearningUserLabel,
  MemoryExecutionContext,
  MemoryHandoffMetadata,
  MemoryLearningHandoff,
  MemoryWriteOrigin,
  ProceduralLearningDestination,
  ProceduralLearningInput,
  ProceduralLearningResult,
  ReasoningLearningHandoff,
  RecordProceduralLearningInput,
  ReviewableLearningProposal,
  SkillConsumerImpact,
  SkillConsumerImpactScanInput,
  SkillGovernanceAction,
  SkillGovernanceDecision,
  SkillGovernanceInput,
  SkillGovernanceMode,
  SkillLearningApplyInput,
  SkillLearningProposal,
  SkillMutationApplyResult,
  SkillMutationChange,
  SkillOwnership,
  SkillSnapshotLocation,
  SkillTrustLedgerReadResult,
  SkillTrustRecord,
  SkillTrustState,
  SkillTrustUpdateInput,
  SkillTrustUpdateResult,
  SkillUsageEvent,
  SkillUsageEventInput,
  SkillUsageLedgerReadResult,
  SkillUsageRecord,
  SkillUsageRecordResult,
  SkillWriteOrigin,
  StoredLearningApplyPlan,
  StoredLearningApprovalResult,
  StoredLearningProposal,
  StoredSkillLearningApplyPlan,
  TraceOnlyLearningReport,
  WorkflowLearningHandoff,
  WorkflowLearningSuggestedAction,
} from './learning/index.js';
export {
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_SUPPORT_FILE_BYTES,
  applySkillLearningProposal,
  approveStoredLearningProposal,
  canMarkCreatedByAgent,
  computeSkillConsumerImpact,
  decideSkillGovernance,
  readLearningProposalStore,
  readSkillTrustLedger,
  readSkillUsageLedger,
  recordCompletedTurnLearning,
  recordProceduralLearning,
  recordSkillUsage,
  resolveLearningProposalStore,
  resolveSkillSnapshotLocation,
  resolveSkillTrustLedger,
  resolveSkillUsageLedger,
  triageProceduralLearning,
  updateLearningProposalStatus,
  updateSkillTrustLedger,
  upsertLearningProposal,
} from './learning/index.js';
export type {
  CreateLearningCenterServiceOptions,
  CreateLearnedSkillActionDriverOptions,
  CreateLearnedSkillRecordInput,
  CommitLearnedSkillRevisionInput,
  DeclarativeSkillSpec,
  LearnedAreaPaths,
  LearnedCapabilityArtifact,
  LearnedCapabilityCanary,
  LearnedCapabilityCanaryBinding,
  LearnedCapabilityCanaryInvocation,
  LearnedCapabilityCarrier,
  LearnedCapabilityLifecycle,
  LearnedCapabilityProvenance,
  LearnedCapabilityRecord,
  LearnedCapabilityRecordV1,
  LearnedCapabilityRecordV2,
  LearnedCapabilityScope,
  LearnedSkillBindingAdmission,
  LearnedSkillCanaryOutcome,
  LearnedSkillInvocationAdmission,
  LearnedSkillInvokedReceipt,
  LearnedSkillOfferedReceipt,
  LearnedSkillOutcomeReceipt,
  LearnedSkillUsageReceipt,
  LearnedCapabilitySource,
  LearningAction,
  LearningActionDriver,
  LearningCapabilityErrorCode,
  LearningCenterService,
  LearningClientEventState,
  LearningClientRecord,
  LearningEvent,
  LearningExplicitUserAuthority,
  LearningEventKind,
  LearningNotificationState,
  LearningPage,
  LegacyLearnedSkillMigrationResult,
  LearningProposalProjection,
  LearningQuery,
  LearningSubscribeOptions,
  LearningSurfaceSnapshot,
  StagedLearnedSkillArtifact,
} from './learning/index.js';
export {
  admitLearnedSkillBinding,
  admitAndRecordLearnedSkillInvocation,
  completeLearnedSkillOutcome,
  completeLearnedSkillSessionOutcomes,
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  createLearnedSkillRecord,
  FileLearningCenterService,
  LearnedAreaStore,
  LearningCapabilityError,
  assertLearnedCapabilityTransition,
  canTransitionLearnedCapability,
  createLearningCenterService,
  createLearnedSkillActionDriver,
  eventFromCapability,
  getLearnedExtensionToolName,
  exactInvokedSkillSnapshotForSession,
  invokeLearnedSkillCanary,
  isLearnedCapabilityRecordV2,
  quarantineLearnedSkillRevision,
  isLearnedExtensionCommandAllowed,
  learningEventIdFor,
  learningEventKindForLifecycle,
  listLearnedSkillUsageReceipts,
  reconcileLearnedSkillBindingOutcomes,
  migrateLegacyLearnedSkillsForProject,
  releaseLearnedSkillBinding,
  renderDeclarativeSkill,
  recordLearnedSkillOffered,
  resolveProjectLearnedAreaRoot,
  stageLearnedSkillRevision,
  validateDeclarativeSkillSpec,
  projectLearningProposals,
  resolveLearnedAreaPaths,
  slugifyLearnedCapabilityName,
} from './learning/index.js';
export {
  acquireLearningFileLock as acquireKodaXFileLock,
  KodaXFileLockTimeoutError,
  reclaimStaleLearningFileLock as reclaimStaleKodaXFileLock,
  withLearningFileLock as withKodaXFileLock,
} from './learning/store-lock.js';

// ============== FEATURE_194 v0.7.43 — MCP capability (inlined from @kodax-ai/mcp) ==============
// Originally a standalone package, inlined per ADR-036 to consolidate single-consumer
// agent capabilities. Public API is byte-identical; downstream import via
// '@kodax-ai/agent' top-level or '@kodax-ai/agent/capabilities/mcp' subpath.
export * from './capabilities/mcp/index.js';

// ============== FEATURE_194 v0.7.43 — Skills system (inlined from @kodax-ai/skills) ==============
// Originally a standalone package, inlined per ADR-036 to consolidate single-consumer
// agent capabilities. Public API is byte-identical; downstream import via
// '@kodax-ai/agent' top-level or '@kodax-ai/agent/capabilities/skills' subpath.
// Subpath '@kodax-ai/agent/capabilities/skills/shared/yaml' also available for
// the markdown-loader (FEATURE_191) parseYamlFrontmatter consumer.
export * from './capabilities/skills/index.js';

// ============== FEATURE_194 v0.7.43 — Tracing (inlined from @kodax-ai/tracing, agent self-merge) ==============
// agent 本就 depend on tracing; inline 把循环依赖收敛为 intra-package.
// Public API byte-identical; downstream import via '@kodax-ai/agent' top-level
// or '@kodax-ai/agent/tracing' subpath.
export * from './tracing/index.js';

// ============== FEATURE_194 v0.7.43 — Session lineage (inlined from @kodax-ai/session-lineage) ==============
// Originally split out of agent per FEATURE_142 Batch B (v0.7.35.1) to avoid
// circular dep; FEATURE_194 inlines it back as the cycle resolution since
// agent already imported session-lineage internally. Public API byte-identical
// via '@kodax-ai/agent' top-level + './session-lineage' subpath.
// Latent bug fix: agent/package.json previously imported session-lineage
// without declaring it in dependencies; inline collapses to intra-package.
export * from './session-lineage/index.js';

// FEATURE_217 (v0.7.49) — Dynamic Workflow Harness Runtime.
// Domain-neutral workflow orchestration; also available at the
// `@kodax-ai/agent/workflow` subpath. Coding provides the backend.
export * from './workflow/index.js';
export * from './external-agents/index.js';

// FEATURE_270 (v0.7.72) - Runtime-owned recursive Actor/Turn control plane.
export * from './actors/index.js';
