/**
 * KodaX Agent
 *
 * Agent 主循环 - Core 层核心入口
 */

import {
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXEvents,
  KodaXJsonValue,
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXRepoIntelligenceMode,
  KodaXReasoningMode,
  KodaXResult,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
  SessionErrorMetadata,
} from '../types.js';
import type {
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import {
  classifyStopReason,
  createCostTracker,
  recordUsage,
  recordRetry,
  getSummary,
  formatCostReport,
  mapLegacyReasoningModeToEffortIntent,
  resolvePromptCacheDisabled,
  type CostTracker,
} from '@kodax-ai/llm';
import path from 'path';
// FEATURE_093 (v0.7.24): `KodaXClient` is only re-exported from this module
// for backward compatibility. Importing it here creates a cycle
// (agent ↔ client, since client imports `runKodaX` from this file). The
// public barrel `index.ts` re-exports `KodaXClient` directly from
// `./client.js` instead — see line ~592.
import { resolveProvider } from '../providers/index.js';
import { listToolDefinitions } from '../tools/index.js';
import { commitActorNotificationReceipts } from '../tools/agent-collaboration.js';
import { mergeManagedProtocolPayload } from '../managed-protocol.js';
// CAP-075 (`getManagedBlockNameForRole`, `hasManagedProtocolForRole`,
// `textContainsManagedBlock`, `MANAGED_PROTOCOL_TOOL_NAME`) is wired
// inside `agent-runtime/managed-protocol-continue.ts` since FEATURE_100 P3.5b.
import { generateSessionId, extractTitleFromMessages } from '../session.js';
// FEATURE_076 Q4: load-time normalization for pre-v0.7.25 session messages.
import { normalizeLoadedSessionMessages } from '../task-engine/_internal/round-boundary.js';
import {
  createMemoryControlPlane,
  captureEpisodeReviewBranchEpoch,
  persistPendingEpisodeReview,
  registerActiveRootQueueRoute,
  type CompactionConfig,
  type KodaXHandledMemoryOperation,
  type MemoryManagementController,
  type MemoryPack,
} from '@kodax-ai/agent';
import {
  createMemoryAgent,
  type MemoryInterventionTrigger,
  type MemoryReminder,
  type MemorySession,
} from '@kodax-ai/agent/experimental-memory';
import { loadCompactionConfig } from '../compaction-config.js';
// CAP-014/060/061/062 token estimation now happens inside the
// substrate compaction modules; agent.ts no longer imports
// `estimateTokens` directly since FEATURE_100 P3.4c.
// CAP-074 (KODAX_MAX_MAXTOKENS_RETRIES) is consumed inside
// `agent-runtime/max-tokens-continuation.ts` since FEATURE_100 P3.5a.
import { waitForRetryDelay } from '../retry-handler.js';
import { telemetryRecovery } from '../resilience/index.js';
import {
  buildPromptMessageContent,
  toKodaXInputArtifacts,
} from '../input-artifacts.js';
import {
  appendPromptIfNotDuplicate,
  discoverAutoResumeSessionId,
  resolveInitialMessages,
} from './middleware/auto-resume.js';
import {
  createReasoningPlan,
  type ReasoningPlan,
} from '../reasoning.js';
import { effortToLegacyReasoningMode } from '@kodax-ai/llm';
import { resolveExecutionCwd, resolveExecutionPath } from '../runtime-paths.js';
import {
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
  resolveKodaXHotPathRepoMode,
} from '../repo-intelligence/runtime.js';
import {
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  rebaseContextTokenSnapshot,
  resolveContextTokenCount,
} from '../token-accounting.js';
import {
  applyContextCapacityReserveOverride,
  cleanupUserInputDegradationCache,
  createUserInputDegradationCache,
  degradeIrreducibleUserInputs,
} from '../capacity-recovery.js';
// CAP-082 (`createEstimatedContextTokenSnapshot`) is consumed inside
// `agent-runtime/catch-terminals.ts:runCatchCleanup` since FEATURE_100 P3.5d.
// CAP-079 (`applyToolResultGuardrail`) is now wired inside
// `agent-runtime/tool-dispatch.ts:runToolDispatch` since FEATURE_100 P3.3d.
// CAP-002 (`cleanupIncompleteToolCalls`, `validateAndFixToolHistory`) is
// consumed inside `agent-runtime/catch-terminals.ts:runCatchCleanup`
// since FEATURE_100 P3.5d. Public surface for these helpers is the
// `agent.ts` shim re-export — no duplicate re-export here.
import {
  cleanupIncompleteToolCalls,
  collectGuardrails,
  createAgent,
  ContextCapacityError,
  createRuntimeDeliveryPredicate,
  emitKodaXDiagnostic,
  getSessionMessageEntryId,
  getMessageQueue,
  validateAndFixToolHistory,
  type Agent,
} from '@kodax-ai/agent';
// CAP-010 (`getToolExecutionOverride`) was used inline before CAP-024;
// since CAP-024 moved into `agent-runtime/tool-dispatch.ts`, this
// agent.ts no longer imports it directly.
import {
  estimateProviderPayloadBytes,
  bucketProviderPayloadSize,
} from './provider-payload.js';
import { checkPromiseSignal } from './thinking-mode-replay.js';
import { emitResilienceDebug } from './resilience-debug.js';
import {
  isVisibleToolName,
  hasQueuedFollowUp,
  emitIterationStart as emitIterationStartStep,
  emitIterationEnd as emitIterationEndStep,
  emitSessionStart,
  emitStreamEnd,
  emitComplete,
  createLiveTurnScope,
  emitTurnCompleted,
  emitTurnFailed,
  emitTurnStarted,
  withLiveTurnAttribution,
} from './event-emitter.js';
import { actorQueueId } from './actor-queue.js';
import { resolvePerTurnProvider } from './per-turn-provider-resolution.js';
import {
  deriveCodingMemoryIdentity,
  drainCodingMemoryReviewInbox,
  persistMemoryOutcomeToSession,
} from '../memory-runtime.js';
import { prepareCodingLearnedSkillBinding } from '../learned-skill-runtime.js';
import {
  installProductionLearningReviewer,
} from '../learning-reviewer.js';
export { shouldInstallProductionLearningReviewer } from '../learning-reviewer.js';
import {
  buildCodingMemoryContext,
  type CodingMemoryContext,
} from '../memory/coding-context.js';
import {
  collectVerifiedCheckFacts,
  resolveLearnedSkillCanaryOutcome,
} from '../memory/verified-checks.js';
import { recordMemoryDecisionReceipt } from '../memory/decision-trace.js';
import {
  MEMORY_EVIDENCE_TOKEN_RESERVE,
  renderMemoryEvidenceEnvelope,
} from '../memory/rendering.js';
import {
  buildToolMemoryObservations,
  codingMemorySourcePolicy,
} from '../memory/coding-observations.js';
import {
  activateMemoryRecallTool,
  createMemoryRecallBinding,
  MEMORY_RECALL_TOOL_NAME,
} from '../tools/memory-recall.js';
import {
  activateMemoryIntentTool,
  createMemoryIntentBinding,
  extractPresentedMemoryTargetRefs,
  MEMORY_INTENT_TOOL_NAME,
} from '../tools/memory-intent.js';
import {
  activateSessionHistoryTools,
  canActivateSessionHistoryTools,
} from '../tools/session-history.js';
import { assertProviderConfigured } from './provider-config-check.js';
import { buildToolExecutionContext } from './tool-execution-context.js';
import { resolvePerTurnReasoning } from './per-turn-reasoning.js';
import { buildStreamTimers } from './stream-timers.js';
import { applyProviderPolicyGate } from './provider-policy-gate.js';
import { validateInputArtifactsForModel } from '../media/index.js';
import { buildStreamHandlers } from './stream-handler-wiring.js';
import { BoundaryTrackerSession } from './boundary-tracker-session.js';
import { withDurableCompactionPersistence } from './durable-compaction.js';
import {
  buildResilienceSession,
  translateAbortError,
  runRecoveryPipeline,
} from './provider-retry-policy.js';
import { executeNonStreamingFallback } from './non-streaming-fallback.js';
import { guardEmptyAssistantContent } from './assistant-message-builder.js';
import { checkAndRetryIncompleteTools } from './incomplete-tool-retry.js';
import {
  checkPreToolAbort,
  hasCancelledToolResult,
  applyCancellationTerminal,
  CANCELLATION_LAST_TEXT,
} from './tool-cancellation.js';
import { describeTransientProviderRetry } from './provider-retry-policy.js';
// CAP-037 predicates (`isToolResultErrorContent`) consumed inside the
// dispatch substrate (CAP-024 / CAP-078) since FEATURE_100 P3.3d.
import {
  applyToolVisibilityPolicy,
  filterExcludedTools,
  getActiveToolDefinitions,
  getRuntimeActiveToolNames,
} from './tool-resolution.js';
import { listRunScopedTools, runScopedToolMap } from './run-scoped-tools.js';
import { createRuntimeContextBudgetSnapshot } from './context-budget.js';
import {
  emitPromptCacheDiagnosticRequest,
  emitPromptCacheDiagnosticResponse,
} from './prompt-cache-diagnostics.js';
import { derivePromptCacheAffinityKey } from './prompt-cache-affinity.js';
import {
  applyToolExposurePlan,
  hasPortableToolBridge,
  planToolExposure,
  selectRuntimeContextOptimizationProfile,
} from './tool-exposure-planner.js';
// FEATURE_189 Batch 3 B.2 — progressive disclosure: read the per-context
// unlock set on each turn so deferred tools' full descriptions surface
// after `tool_search` runs.
import { getUnlockedDeferredTools } from '../tools/deferred-tools.js';
// CAP-028 / CAP-062 (`gracefulCompactDegradation`) is wired inside
// `agent-runtime/middleware/compaction-orchestration.ts` since
// FEATURE_100 P3.4c.
import { shouldCompact, getCachedRejectedEfforts } from '@kodax-ai/agent';
import { resolveWireEffort } from '@kodax-ai/llm';
import { runCompactionLifecycle } from './middleware/compaction-orchestration.js';
import { createCompactionAntiThrashState } from './middleware/compaction-pressure.js';
import { maybeContinueAfterMaxTokens } from './max-tokens-continuation.js';
import { maybeAutoContinueManagedProtocol } from './managed-protocol-continue.js';
import { applyIterationLimitTerminal } from './iteration-limit-terminal.js';
import {
  runCatchCleanup,
  applyAbortErrorTerminal,
  applyGenericErrorTerminal,
} from './catch-terminals.js';
// CAP-026 (`updateToolOutcomeTracking`) is now wired inside
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` since
// FEATURE_100 P3.3d.
import {
  type ProviderPrepareState,
  applyProviderPrepareHook,
} from './provider-hook.js';
import {
  runToolDispatch,
  applyPostToolProcessing,
} from './tool-dispatch.js';
import { buildToolResultBudgetFromUsage } from '../tools/tool-result-budget.js';
import { repairToolBlockNames } from './tool-name-repair.js';
import { buildReasoningExecutionState } from './reasoning-plan-entry.js';
import { resolveContextWindow } from '@kodax-ai/agent';
import {
  type RuntimeSessionState,
  buildRuntimeSessionState,
  snapshotRuntimeSessionState,
} from './runtime-session-state.js';
import {
  saveRequiredSessionSnapshot,
  saveSessionSnapshot,
} from './middleware/session-snapshot.js';
import { emitRepoIntelligenceTrace } from './middleware/repo-intelligence.js';
// CAP-015 (`buildEditRecoveryUserMessage`, `RunnableToolCall`) and
// CAP-016 mutation-reflection helpers are wired inside
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` since
// FEATURE_100 P3.3d.
import {
  appendQueuedRuntimeMessages,
  createExtensionRuntimeSessionController,
  pushToolResultsAndSettle,
  settleExtensionTurn,
} from './middleware/extension-queue.js';
import {
  bindActiveExtensionExecutionRuntime,
  emitActiveExtensionEvent,
  getActiveExtensionRuntime,
  setActiveExtensionRuntime,
  KodaXExtensionRuntime,
} from '../extensions/runtime.js';

// CAP-019 (`AutoReroutePlan`) lives in
// `agent-runtime/middleware/auto-reroute.ts` since FEATURE_100 P2.
// CAP-015 (`RunnableToolCall`) lives in
// `agent-runtime/middleware/edit-recovery.ts` since FEATURE_100 P2;
// imported above for use in the dispatch loop.
//
// `MessageContentBlock` (alias for the array element type of
// `KodaXMessage.content`) used to live here for the local content-block
// predicates; both predicates moved to `agent-runtime/compaction-fallback.ts`
// with CAP-028 in FEATURE_100 P2, and the alias was deleted along with
// its sole consumer.

// CAP-050 (`RuntimeSessionState` interface) lives in
// `agent-runtime/runtime-session-state.ts` since FEATURE_100 P2.
// Imported as a type-only symbol above.

// CAP-023 (`applyProviderPrepareHook`, `ProviderPrepareState`) lives in
// `agent-runtime/provider-hook.ts` since FEATURE_100 P2.
// `ProviderPrepareState` is imported above as a type so the call site
// at `runKodaX`'s prepare-hook step keeps its existing shape.

// CAP-040 (`filterExcludedTools`) lives in
// `agent-runtime/tool-resolution.ts` since FEATURE_100 P2.
// Imported above for the call site that builds
// `RuntimeSessionState.activeTools`.

// CAP-001 (`buildAutoRepoIntelligenceContext`, `emitRepoIntelligenceTrace`,
// `shouldEmitRepoIntelligenceTrace`) lives in
// `agent-runtime/middleware/repo-intelligence.ts` since FEATURE_100 P2.
// `emitRepoIntelligenceTrace` is imported above for the 'routing' stage
// emission at frame entry; `buildAutoRepoIntelligenceContext` is also
// re-exported so `runner-driven.ts:64` keeps working unchanged.

// CAP-028 (`gracefulCompactDegradation`) lives in
// `agent-runtime/compaction-fallback.ts` since FEATURE_100 P2.
// The two content-block predicates (`isTypedContentBlock`,
// `isToolResultContentBlock`) moved with it; `isToolUseContentBlock`
// was retired here because its callers (inside
// `validateAndFixToolHistory`) had already moved to
// `agent-runtime/history-cleanup.ts` (CAP-002) along with their own
// local copy of the predicate, leaving the agent.ts copy without any
// consumer.

// CAP-020 (`normalizeQueuedRuntimeMessage`, `normalizeRuntimeModelSelection`,
// `createSessionRecordId`) lives in `agent-runtime/runtime-session-state.ts`
// since FEATURE_100 P2. CAP-030 will move
// `normalizeRuntimeModelSelection` to `provider-hook.ts` in a later batch.

// CAP-031 (`describeTransientProviderRetry`) lives in
// `agent-runtime/provider-retry-policy.ts` since FEATURE_100 P2.
// Imported above for the resilience-retry banner emission and re-exported
// so `task-engine/runner-driven.ts:67` keeps working without an
// import-path churn.

// CAP-050 (`createRuntimeExtensionState`, `snapshotRuntimeExtensionState`,
// `getExtensionStateBucket`) live in `agent-runtime/runtime-session-state.ts`
// since FEATURE_100 P2.
//
// CAP-020 (`createExtensionRuntimeSessionController`,
// `appendQueuedRuntimeMessages`, `settleExtensionTurn`) lives in
// `agent-runtime/middleware/extension-queue.ts` since FEATURE_100 P2.
// All three are imported above for the call sites in this file.

// CAP-021 (`getActiveToolDefinitions`) + CAP-022 (`getRuntimeActiveToolNames`)
// live in `agent-runtime/tool-resolution.ts` since FEATURE_100 P2.
// Imported above for the dispatch loop's per-turn tool resolution.

// CAP-002 (cleanupIncompleteToolCalls + validateAndFixToolHistory) lives in
// `agent-runtime/history-cleanup.ts` since FEATURE_100 P2. Imported at the top
// of this file alongside other agent-runtime modules.

// CAP-039 (`checkPromiseSignal`) lives in
// `agent-runtime/thinking-mode-replay.ts` since FEATURE_100 P2.
// Re-exported above so external callers (`../index.js`) keep working
// without an import-path churn. The former in-tree caller
// `scout-signals.ts` was deleted in FEATURE_193 V1 cleanup.

// CAP-038 (`hasQueuedFollowUp`) lives in
// `agent-runtime/event-emitter.ts` since FEATURE_100 P2.
// CAP-037 (`isToolResultErrorContent`, `isCancelledToolResultContent`)
// lives in `agent-runtime/tool-result-classify.ts` since FEATURE_100 P2.

// CAP-016 (`MUTATION_TOOL_NAMES`, `isMutationTool`,
// `isMutationScopeSignificant`, `buildMutationScopeReflection`) lives in
// `agent-runtime/middleware/mutation-reflection.ts` since FEATURE_100 P2.
// The post-tool-result call site moved into
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` in
// FEATURE_100 P3.3d (CAP-078).

// CAP-010 (`getToolExecutionOverride`) lives in
// `agent-runtime/permission-gate.ts` since FEATURE_100 P2.

// CAP-011 + CAP-013 (`saveSessionSnapshot`) live in
// `agent-runtime/middleware/session-snapshot.ts` since FEATURE_100 P2.
// The function is imported above for the four in-file calling sites
// and re-exported (line 130) so `runner-driven.ts:70` keeps working.

// `createToolResultBlock` (helper, no own CAP) lives in
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2 (CAP-024 batch).
// agent.ts no longer imports it directly since FEATURE_100 P3.3d —
// the dispatch loop's result-block construction sites are now inside
// `runToolDispatch` and `applyPostToolProcessing` in the same module.

// CAP-035 (`isVisibleToolName`) lives in
// `agent-runtime/event-emitter.ts` since FEATURE_100 P2.
// CAP-036 (`shouldDebugResilience`, `emitResilienceDebug`) lives in
// `agent-runtime/resilience-debug.ts` since FEATURE_100 P2.

// CAP-032 (`extractStructuredToolErrorCode`) lives in
// `agent-runtime/tool-result-classify.ts` since FEATURE_100 P2 (shared
// with CAP-037 in the same module).

// CAP-015 (`resolveToolTargetPath`, `clearEditRecoveryStateForPath`,
// `maybeBlockExistingFileWrite`, `buildEditRecoveryUserMessage`) lives in
// `agent-runtime/middleware/edit-recovery.ts` since FEATURE_100 P2.
// `buildEditRecoveryUserMessage` is now consumed by
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` since
// FEATURE_100 P3.3d.

// CAP-026 (`updateToolOutcomeTracking`) lives in
// `agent-runtime/middleware/tool-outcome-tracking.ts` since FEATURE_100 P2.
// Co-located inside `agent-runtime/tool-dispatch.ts:applyPostToolProcessing`
// since FEATURE_100 P3.3d (CAP-078).

// CAP-027 (`estimateProviderPayloadBytes`, `bucketProviderPayloadSize`) lives
// in `agent-runtime/provider-payload.ts` since FEATURE_100 P2.

// CAP-019 (`maybeBuildAutoReroutePlan`, `maybeAdvanceAutoReroute`) lives in
// `agent-runtime/middleware/auto-reroute.ts` since FEATURE_100 P2.
// `maybeAdvanceAutoReroute` takes `buildExecutionState` as a callback so
// that `buildReasoningExecutionState` (CAP-052, still in this file) does
// not need to be moved together — see auto-reroute.ts docstring.
//
// CAP-017 + CAP-018 (`looksLikeReviewProgressUpdate`,
// `isReviewFinalAnswerCandidate`, `hasStrongToolFailureEvidence`) live in
// `agent-runtime/middleware/judges.ts` since FEATURE_100 P2.

// CAP-024 (`executeToolCall`) lives in
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2. agent.ts no
// longer imports it directly since FEATURE_100 P3.3d — both bash and
// non-bash dispatch are wrapped inside `runToolDispatch` in the same
// module.

// CAP-025 (`tryMcpFallback`, `MCP_FALLBACK_ALLOWED_TOOLS`) lives in
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2.

// CAP-077 (`runToolDispatch` — bash sequential / non-bash parallel +
// CAP-079 guardrail wrapping) and CAP-078 (`applyPostToolProcessing` —
// per-result chain) live in `agent-runtime/tool-dispatch.ts` since
// FEATURE_100 P3.3d. Imported above for the dispatch loop's two-step
// invocation inside `runKodaX`.

function legacyReasoningModeToRuntimeEffort(
  mode: KodaXReasoningMode | undefined,
): KodaXOptions['effort'] {
  if (!mode) return undefined;
  const mapped = mapLegacyReasoningModeToEffortIntent(mode) as KodaXOptions['effort'] | undefined;
  return mapped ?? mode;
}

function renderMemoryReminderSuffix(reminder: MemoryReminder): KodaXEphemeralSuffix | undefined {
  const content = renderMemoryEvidenceEnvelope(reminder.content, reminder.evidenceRefs);
  return content === undefined ? undefined : { content };
}

function throwCallerAbort(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error(
    signal.reason === undefined ? 'Operation aborted.' : String(signal.reason),
  );
  error.name = 'AbortError';
  throw error;
}

function replaceLatestAssistantToolBlocks(
  messages: KodaXMessage[],
  result: KodaXStreamResult,
): void {
  const index = messages.length - 1;
  const message = messages[index];
  if (!message || message.role !== 'assistant') return;
  const visibleToolBlocks = result.toolBlocks.filter((block) => isVisibleToolName(block.name));
  messages[index] = {
    ...message,
    content: guardEmptyAssistantContent([
      ...result.thinkingBlocks,
      ...result.textBlocks,
      ...visibleToolBlocks,
    ]),
  };
}

function withCompletionEventOnce(events: KodaXEvents): KodaXEvents {
  const onComplete = events.onComplete;
  if (onComplete === undefined) return events;
  let emitted = false;
  return {
    ...events,
    onComplete: (meta) => {
      if (emitted) return;
      emitted = true;
      onComplete(meta);
    },
  };
}

/**
 * Substrate executor body — the full SA execution pipeline (provider
 * resolution, tool loop, microcompact, edit recovery, extension queue,
 * managed protocol, terminals). FEATURE_100 (v0.7.29) renamed this from
 * `runKodaX` to `runSubstrate` so the public-facing `runKodaX`
 * (`agent.ts`) can become a thin `Runner.run(defaultCodingAgent, …)`
 * shim per ADR-020.
 *
 * Direct callers (the coding preset's substrate executor closure +
 * `runKodaX` shim) only — SDK consumers should use `runKodaX` or
 * `Runner.run(createDefaultCodingAgent(), …)`.
 */
const MAX_INTERRUPT_CONTINUATION_ITERATIONS = 8;

function attributeProviderRequest(events: KodaXEvents, providerRequestId: string): KodaXEvents {
  return {
    ...events,
    onTextDelta: (text, meta) =>
      events.onTextDelta?.(text, { ...meta, providerRequestId }),
    onThinkingDelta: (text, meta) =>
      events.onThinkingDelta?.(text, { ...meta, providerRequestId }),
    onThinkingEnd: (thinking, meta) =>
      events.onThinkingEnd?.(thinking, { ...meta, providerRequestId }),
  };
}

export async function runSubstrate(
  options: KodaXOptions,
  prompt: string,
  declaredAgent?: Agent,
): Promise<KodaXResult> {
  const previousActiveRuntime = getActiveExtensionRuntime();
  const runtime = options.extensionRuntime ?? previousActiveRuntime;
  const activeRegistryRuntime = options.extensionRuntime instanceof KodaXExtensionRuntime
    ? options.extensionRuntime
    : undefined;
  const didSetActiveRuntime = !!activeRegistryRuntime && activeRegistryRuntime !== previousActiveRuntime;
  if (didSetActiveRuntime && activeRegistryRuntime) {
    setActiveExtensionRuntime(activeRegistryRuntime);
  }
  const releaseActiveExecutionRuntime = bindActiveExtensionExecutionRuntime(runtime);
  let releaseRuntimeBinding: (() => void) | undefined;
  let releaseActiveRootQueueRoute: (() => void) | undefined;
  const userInputDegradationCache = createUserInputDegradationCache();
  try {
  const maxIter = options.maxIter ?? 200;
  const absoluteIterationLimit = maxIter + MAX_INTERRUPT_CONTINUATION_ITERATIONS;
  let iterationLimit = maxIter;
  const reserveInterruptContinuation = (iteration: number): boolean => {
    if (iteration + 1 < iterationLimit) return true;
    if (iterationLimit >= absoluteIterationLimit) return false;
    iterationLimit += 1;
    return true;
  };
  const canReopenInterruptInput = (iteration: number): boolean =>
    iteration + 1 < iterationLimit && iterationLimit < absoluteIterationLimit;
  let events = options.events ?? {};
  const toolGuardrails = collectGuardrails(options.guardrails).tool;
  const guardrailAgent = toolGuardrails.length > 0
    ? declaredAgent ?? createAgent({
        name: 'KodaX Coding Agent',
        instructions: 'Execute the coding substrate with the declared run guardrails.',
      })
    : undefined;
  const runtimeDefaults = runtime?.getDefaults?.();

  // FEATURE_100 P3.6b/d/e — ten per-loop counters/latches/accumulators
  // consolidated into one mutable accumulator. The substrate executor
  // (P3.6f) will absorb these into TurnContext fields. The object
  // reference is stable; only its fields mutate, so closures (e.g.
  // `events.getCostReport.current`) that capture `turnState` see the
  // current values at call time.
  //
  // `turnState.lastText` is the assistant's most-recent response text — used by
  // judges, terminals, and signal extraction. The provider trio
  // (`turnState.currentProviderName` / `turnState.currentModelOverride` / `turnState.runtimeThinkingLevel`)
  // was P3.1-deferred; per turn-context.ts:131-135 the substrate
  // executor will re-derive them from `sessionState.modelSelection` at
  // turn-start, but until P3.6f lands they live on `turnState` so the
  // grep gate is satisfied.
  const turnState = {
    preAnswerJudgeConsumed: false,
    postToolJudgeConsumed: false,
    maxTokensRetryCount: 0,
    costTracker: createCostTracker() as CostTracker,
    managedProtocolContinueAttempted: false,
    compactConsecutiveFailures: 0,
    compactAntiThrash: createCompactionAntiThrashState(),
    lastText: '',
    currentProviderName: runtimeDefaults?.modelSelection.provider ?? options.provider,
    currentModelOverride: runtimeDefaults?.modelSelection.model ?? options.modelOverride ?? options.model,
    runtimeThinkingLevel: runtimeDefaults?.thinkingLevel,
  };

  // Resolve the initial provider first so we know the context window —
  // loadCompactionConfig uses it to pick an adaptive triggerPercent
  // (short-window models compact earlier; user config can still override).
  // Pass the per-model value so providers with model-specific windows
  // (ark-coding's deepseek-v3.2 128K / kimi-k2.6 256K / deepseek-v4 1M,
  // etc.) get the right adaptive bucket instead of the default-model
  // window.
  const initialProvider = resolveProvider(turnState.currentProviderName);
  assertProviderConfigured(initialProvider, turnState.currentProviderName);
  options = installProductionLearningReviewer(
    options,
    initialProvider,
    turnState.currentModelOverride,
  );
  const initialContextWindow =
    initialProvider.getEffectiveContextWindow?.(turnState.currentModelOverride)
    ?? initialProvider.getContextWindow();
  const compactionConfig = await loadCompactionConfig(
    initialContextWindow,
    options.compaction,
  );

  // CAP-043: autoResume / resume — pick the most recent persisted
  // session when no explicit id was supplied. Folded into
  // `discoverAutoResumeSessionId` during P3.6n.
  const resolvedSessionId = await discoverAutoResumeSessionId(options);
  const sessionId = resolvedSessionId ?? await generateSessionId();
  const contextIdentitySessionId = options.context?.contextIdentitySessionId ?? sessionId;
  const requestedLiveTurn = options.context?.liveTurn;
  const currentAgentId = options.context?.currentAgentId;
  const parentAgentId = options.context?.parentAgentId;
  const liveTurnScope = createLiveTurnScope({
    sessionId,
    deliveryKind: requestedLiveTurn?.deliveryKind ?? 'initial',
    turnId: requestedLiveTurn?.turnId,
    deliveryId: requestedLiveTurn?.deliveryId,
    promptId: requestedLiveTurn?.promptId,
    ...(currentAgentId !== undefined
      ? {
          contextId: `${contextIdentitySessionId}/agent/${encodeURIComponent(currentAgentId)}`,
          contextKind: 'child' as const,
          parentContextId: parentAgentId === undefined || parentAgentId === '/root'
            ? contextIdentitySessionId
            : `${contextIdentitySessionId}/agent/${encodeURIComponent(parentAgentId)}`,
          agentId: currentAgentId,
        }
      : {}),
    ownsContextRevision: options.context?.ownsContextRevision,
  });
  const liveTurnScopeRef = { current: liveTurnScope };
  const memoryIntentUserTurnRef = {
    current: {
      text: options.context?.rawUserInput?.trim() || prompt,
      turnId: liveTurnScope.turnId,
    },
  };
  events = withDurableCompactionPersistence({
    events,
    storage: options.session?.storage,
    sessionId,
    persistedByHost: options.session?.persistedByHost,
    currentAgentId,
    sessionScope: options.session?.scope,
    initialSessionData: {
      title: prompt.slice(0, 80),
      gitRoot: options.context?.gitRoot ?? '',
      ...(options.session?.scope !== undefined ? { scope: options.session.scope } : {}),
      ...(options.session?.tag !== undefined ? { tag: options.session.tag } : {}),
    },
  });
  events = withLiveTurnAttribution(events, liveTurnScopeRef);
  events = withCompletionEventOnce(events);
  const memoryIdentity = options.context?.memoryIdentity
    ?? deriveCodingMemoryIdentity(options, resolveExecutionCwd(options.context), sessionId);
  const learnedSkillBinding = await prepareCodingLearnedSkillBinding(
    options,
    memoryIdentity,
    sessionId,
  );
  let memoryController: MemoryManagementController | undefined;
  let memoryPack: MemoryPack | undefined;
  let memoryBranchEpoch: number | undefined;
  let memoryReviewDrain: Promise<void> = Promise.resolve();
  let preferredMemoryReviewJobId: string | undefined;
  if (options.context?.currentAgentId === undefined
    && options.context?.parentAgentId === undefined) {
    try {
      memoryController = createMemoryControlPlane({
        cwd: resolveExecutionCwd(options.context),
        identity: memoryIdentity,
        projectDocs: [],
        discoverSkills: false,
        ...(options.memoryReviewer !== undefined ? { memoryReviewer: options.memoryReviewer } : {}),
      });
      memoryPack = await memoryController.buildMemoryPack({
        task: prompt,
        identity: memoryIdentity,
        maxCandidates: 12,
        maxHints: 5,
        includeSnippets: false,
      });
      await memoryController.maybeRunAutoCurator();
      memoryReviewDrain = drainCodingMemoryReviewInbox(
        options,
        memoryIdentity,
        memoryController,
        sessionId,
      ).then(() => undefined).catch((error: unknown) => {
        emitResilienceDebug('[memory:review-inbox:startup-drain-error]', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (options.session?.storage !== undefined) {
        memoryBranchEpoch = await captureEpisodeReviewBranchEpoch(memoryIdentity);
      }
    } catch (error) {
      emitResilienceDebug('[memory:session-start:error]', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  options = {
    ...options,
    events,
    context: {
      ...options.context,
      memoryIdentity,
      ...learnedSkillBinding?.context,
      ...(memoryPack !== undefined ? { memoryPack } : {}),
    },
  };

  // CAP-008: resolve transcript from initialMessages → storage.load → empty;
  // CAP-046: append current prompt unless transcript tail is already the
  // same canonical text. Both helpers live in
  // `agent-runtime/middleware/auto-resume.ts` since FEATURE_100 P2.
  const resumed = await resolveInitialMessages(options, sessionId);
  const transcriptPrompt = options.context?.rawUserInput?.trim() || prompt;
  let messages = appendPromptIfNotDuplicate(
    resumed.messages,
    transcriptPrompt,
    options.context?.inputArtifacts,
    liveTurnScopeRef.current.turnId,
  );
  let title = resumed.title || (
    transcriptPrompt.slice(0, 50) + (transcriptPrompt.length > 50 ? '...' : '')
  );
  const errorMetadata: SessionErrorMetadata | undefined = resumed.errorMetadata;
  const loadedExtensionState: KodaXExtensionSessionState | undefined = resumed.loadedExtensionState;
  const loadedExtensionRecords: KodaXExtensionSessionRecord[] | undefined = resumed.loadedExtensionRecords;

  const executionCwd = resolveExecutionCwd(options.context);

  // FEATURE_100 P3.6p — `emittedManagedProtocolPayload` lifted from a
  // function-local `let` into a `{ current }` wrapper so the
  // emitManagedProtocol closure can live inside `buildToolExecutionContext`.
  const managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined } = {
    current: options.context?.managedProtocolEmission?.enabled
      ? mergeManagedProtocolPayload(undefined, undefined)
      : undefined,
  };

  const ctx = buildToolExecutionContext({
    options,
    // FEATURE_247 (R7) — thread the resolved session id so tool handlers can
    // self-attribute concurrent runs without AsyncLocalStorage.
    sessionId,
    runtime: runtime ?? undefined,
    managedProtocolPayloadRef,
  });
  if (ctx.actorControl !== undefined) {
    ctx.actorTurnRef = {
      actorPath: ctx.actorControl.callerPath,
      turnId: liveTurnScopeRef.current.turnId,
    };
  }
  // A resumed transcript is already durable. Finish any child-result receipt
  // that was left replayable by a crash between transcript commit and Actor
  // acknowledgement.
  await commitActorNotificationReceipts(ctx, messages);
  const messageQueueAgentId = ctx.actorControl
    ? ctx.actorQueueAgentId
      ?? actorQueueId(ctx.contextIdentitySessionId ?? sessionId, ctx.actorControl.callerPath)
    : undefined;
  if (messageQueueAgentId !== undefined && ctx.actorControl?.callerPath === '/root') {
    releaseActiveRootQueueRoute = registerActiveRootQueueRoute(messageQueueAgentId);
  }
  const consumeRuntimeInterruptInput = async (): Promise<boolean> => {
    if (!options.context?.interruptInput) return false;
    const queue = getMessageQueue();
    const promptFilter = {
      agentId: messageQueueAgentId,
      maxPriority: 'user' as const,
      mode: 'prompt' as const,
      predicate: createRuntimeDeliveryPredicate(
        queue.getSnapshot(),
        messageQueueAgentId,
      ),
    };
    const prompts = queue.peek(promptFilter);
    if (prompts.length === 0) return false;
    const preparedPrompts = prompts.map((queued) => {
      const inputArtifacts = toKodaXInputArtifacts(queued.inputArtifacts);
      validateInputArtifactsForModel(inputArtifacts ?? [], {
        provider: turnState.currentProviderName,
        model: turnState.currentModelOverride,
      });
      return { queued, inputArtifacts };
    });
    queue.dequeue(promptFilter);
    const queuedTurnId = startQueuedLiveTurn(prompts[0]?.id);
    memoryIntentUserTurnRef.current = {
      text: prompts.map((queued) => queued.content).join('\n'),
      turnId: queuedTurnId,
    };
    if (ctx.actorControl !== undefined) {
      ctx.actorTurnRef = {
        actorPath: ctx.actorControl.callerPath,
        turnId: queuedTurnId,
      };
    }
    const timestamp = new Date().toISOString();
    const deliveries = preparedPrompts.map(({ queued, inputArtifacts }) => {
      const message: KodaXMessage = {
        role: 'user',
        content: buildPromptMessageContent(queued.content, inputArtifacts),
        turnId: queuedTurnId,
        timestamp,
      };
      messages.push(message);
      return { queued, message };
    });
    if (options.session?.persistedByHost === false) {
      await saveRequiredSessionSnapshot(options, sessionId, {
        messages,
        title,
        gitRoot: options.context?.gitRoot ?? undefined,
        runtimeSessionState,
      });
    }
    const queuedMessageEntryIds: Record<string, string> = {};
    for (const { queued, message } of deliveries) {
      const entryId = getSessionMessageEntryId(message);
      if (entryId !== undefined) queuedMessageEntryIds[queued.id] = entryId;
    }
    events.onMidTurnUserMessages?.(
      deliveries.map(({ queued }) => queued.content),
      {
        queuedMessageIds: deliveries.map(({ queued }) => queued.id),
        queuedMessageEntryIds,
      },
    );
    return true;
  };

  let contextTokenSnapshot = rebaseContextTokenSnapshot(
    messages,
    options.context?.contextTokenSnapshot,
  );
  // Run-scoped tools (daemon Host Tools bound by lease) are appended to the
  // candidate name list ahead of exclude/policy filtering. They never enter
  // the process-global registry, and later turns without the binding simply
  // materialize nothing — removal falls out of per-turn assembly.
  const runScopedToolDefs = listRunScopedTools(runtime);
  const runScopedToolDefsByName = runScopedToolMap(runScopedToolDefs);
  const baseAvailableTools = [
    ...(runtimeDefaults?.activeTools ?? listToolDefinitions().map((tool) => tool.name)),
    ...runScopedToolDefs.map((definition) => definition.name),
  ];
  const contextAvailableTools = options.context?.skillScriptRunner
    ? baseAvailableTools
    : baseAvailableTools.filter((name) => name !== 'run_skill_script');
  const configuredActiveTools = applyToolVisibilityPolicy(
    filterExcludedTools(
      contextAvailableTools,
      options.context?.excludeTools,
    ),
    options.context?.toolVisibilityPolicy,
    runScopedToolDefsByName,
  );
  const memoryRecallToolAllowed = configuredActiveTools.includes(MEMORY_RECALL_TOOL_NAME);
  const memoryIntentToolAllowed = configuredActiveTools.includes(MEMORY_INTENT_TOOL_NAME);
  const sessionHistoryStorage = options.session?.storage;
  const sessionHistoryToolsAllowed = canActivateSessionHistoryTools({
    activeTools: configuredActiveTools,
    sessionId,
    currentAgentId,
    sessionScope: options.session?.scope,
    storage: sessionHistoryStorage,
  });
  const runtimeSessionState = buildRuntimeSessionState({
    loadedExtensionState,
    loadedExtensionRecords,
    // FEATURE_247 (R2): apply the profile tool-visibility policy after the
    // static excludeTools filter, before the model-visible list is built.
    activeTools: activateSessionHistoryTools(
      activateMemoryIntentTool(
        activateMemoryRecallTool(configuredActiveTools, false),
        false,
      ),
      sessionHistoryToolsAllowed,
    ),
    modelSelection: {
      provider: turnState.currentProviderName,
      model: turnState.currentModelOverride,
    },
    thinkingLevel: turnState.runtimeThinkingLevel,
  });
  const terminalLiveTurnIds = new Set<string>();
  const emitLiveTurnCompletedOnce = (
    status: 'completed' | 'interrupted',
  ): void => {
    const scope = liveTurnScopeRef.current;
    if (terminalLiveTurnIds.has(scope.turnId)) return;
    terminalLiveTurnIds.add(scope.turnId);
    emitTurnCompleted(events, scope, status);
  };
  const emitLiveTurnFailedOnce = (error: Error): void => {
    const scope = liveTurnScopeRef.current;
    if (terminalLiveTurnIds.has(scope.turnId)) return;
    terminalLiveTurnIds.add(scope.turnId);
    emitTurnFailed(events, scope, error);
  };
  const startQueuedLiveTurn = (promptId: string | undefined): string => {
    emitLiveTurnCompletedOnce('completed');
    liveTurnScopeRef.current = createLiveTurnScope({
      sessionId,
      deliveryKind: 'queued',
      promptId,
      contextId: liveTurnScope.contextId,
      contextKind: liveTurnScope.contextKind,
      parentContextId: liveTurnScope.parentContextId,
      agentId: liveTurnScope.agentId,
      ownsContextRevision: liveTurnScope.ownsContextRevision,
    });
    emitTurnStarted(events, liveTurnScopeRef.current);
    return liveTurnScopeRef.current.turnId;
  };
  let memorySession: MemorySession | undefined;
  let memoryDecisionBinding: CodingMemoryContext | undefined;
  const handledMemoryOperations: KodaXHandledMemoryOperation[] = [];
  const finalizeManagedProtocolResult = async (result: KodaXResult): Promise<KodaXResult> => {
    const payload = mergeManagedProtocolPayload(
      result.managedProtocolPayload,
      managedProtocolPayloadRef.current,
    );
    const runtimeSessionSnapshot = snapshotRuntimeSessionState(
      runtimeSessionState,
      { includeUnchanged: false },
    );
    const finalized = payload || runtimeSessionSnapshot
      ? {
          ...result,
          ...(payload ? { managedProtocolPayload: payload } : {}),
          ...(runtimeSessionSnapshot ? { runtimeSessionSnapshot } : {}),
        }
      : result;
    if (memorySession !== undefined) {
      const checks = collectVerifiedCheckFacts(finalized.artifactLedger ?? []);
      try {
        const completedAt = new Date().toISOString();
        await memorySession.complete({
            status: finalized.interrupted
              ? 'cancelled'
              : finalized.success ? 'succeeded' : 'failed',
            summary: finalized.lastText,
            evidence: [
              ...(finalized.interrupted
                ? []
                : [
                    ...(checks.length > 0
                      ? checks.map((check) => ({
                          ref: check.ref,
                          requestedGrade: 'verified' as const,
                          source: check.source,
                          verdict: check.verdict,
                          observedAt: check.observedAt,
                        }))
                      : [{
                          ref: `host:run-terminal:${sessionId}`,
                          requestedGrade: 'observed' as const,
                          source: 'host' as const,
                          observedAt: completedAt,
                        }]),
                  ]),
            ],
            ...(handledMemoryOperations.length === 0
              ? {}
              : { handledMemoryOperations: [...handledMemoryOperations] }),
        });
        await memorySession.close();
      } catch (error) {
        emitResilienceDebug('[memory:episode-finalize:error]', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (options.context?.completeLearnedSkillOutcomes !== undefined) {
      const checks = collectVerifiedCheckFacts(finalized.artifactLedger ?? []);
      try {
        await options.context.completeLearnedSkillOutcomes({
          sessionId,
          outcome: resolveLearnedSkillCanaryOutcome(finalized.success, checks),
          evidenceRefs: checks.length > 0
            ? checks.map((check) => check.ref)
            : [`host:run-terminal:${sessionId}`],
        });
      } catch (error) {
        emitResilienceDebug('[learning:skill-outcome:error]', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await learnedSkillBinding?.release();
    } catch (error) {
      emitResilienceDebug('[learning:skill-binding-release:error]', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (memoryController !== undefined) {
      // Deliberately not awaited: the foreground durability boundary is the
      // persisted review job. This chain serializes same-process drains, while
      // a later run recovers any job left behind by process exit.
      memoryReviewDrain = memoryReviewDrain.then(
        () => drainCodingMemoryReviewInbox(
          options,
          memoryIdentity,
          memoryController,
          '',
          // FEATURE_289 §3.1: bound the decide phase so a shutdown-window
          // drain releases its claim via defer instead of fossilizing
          // mid-judge in `processing`.
          Date.now() + 15_000,
          preferredMemoryReviewJobId,
        ).then(() => undefined),
      ).catch((error: unknown) => {
        emitResilienceDebug('[memory:review-inbox:drain-error]', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return finalized;
  };
  const finalizeCompletedProtocolResult = async (
    result: KodaXResult,
  ): Promise<KodaXResult> => {
    const finalized = await finalizeManagedProtocolResult(result);
    try {
      emitComplete(events);
    } catch {
      emitKodaXDiagnostic({
        source: 'coding:completion-observer',
        level: 'warn',
        message: 'Completion observer failed after result finalization.',
      });
    }
    emitLiveTurnCompletedOnce(finalized.interrupted ? 'interrupted' : 'completed');
    return finalized;
  };
  // v0.7.42 — wire optional embedder-facing session control. CAP-055 reads
  // these fields at the start of every turn, so direct mutation here is
  // sufficient — no re-resolve dance required.
  options.sessionControl?._attach({
    setProvider: (name) => {
      runtimeSessionState.modelSelection.provider = name;
    },
    setModel: (model) => {
      runtimeSessionState.modelSelection.model = model;
    },
    setReasoning: (mode) => {
      runtimeSessionState.thinkingLevel = legacyReasoningModeToRuntimeEffort(mode);
    },
  });
  const releaseRuntimeBindingCandidate = runtime?.bindController?.(
    createExtensionRuntimeSessionController(runtimeSessionState),
  );
  releaseRuntimeBinding = typeof releaseRuntimeBindingCandidate === 'function'
    ? releaseRuntimeBindingCandidate
    : undefined;

  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const hotPathRepoMode = resolveKodaXHotPathRepoMode(options.context?.repoIntelligenceMode);

  // v0.7.41 P1.b — hydrateSession (MCP extension state restoration) and the
  // routing-signals lookup is independent, so run it concurrently
  // to collapse two sequential awaits into one wall-time slot. Pin:
  //   - if hydrate throws, Promise.all rejects with the same error (the outer
  //     catch / caller behaviour stays identical to a plain `await hydrate`)
  //   - routing has `.catch(() => null)` so its independent failure cannot
  //     mask the hydration error
  //   - caller-supplied `options.context.repoRoutingSignals` short-circuit
  //     preserved via `Promise.resolve(injected)`
  const routingSignalsPromise = options.context?.repoRoutingSignals
    ? Promise.resolve(options.context.repoRoutingSignals)
    : (autoRepoMode !== 'off' && (options.context?.executionCwd || options.context?.gitRoot))
      ? getRepoRoutingSignals({
          executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: hotPathRepoMode,
        }).catch(() => null)
      : Promise.resolve(null);
  const [, repoRoutingSignals] = await Promise.all([
    runtime?.hydrateSession?.(sessionId),
    routingSignalsPromise,
  ]);
  emitRepoIntelligenceTrace(
    events,
    options,
    'routing',
    repoRoutingSignals,
    repoRoutingSignals?.activeModuleId
      ? `active_module=${repoRoutingSignals.activeModuleId}`
      : undefined,
  );

  let reasoningPlan = await createReasoningPlan({
    ...options,
    provider: turnState.currentProviderName,
    modelOverride: turnState.currentModelOverride,
  }, prompt, initialProvider, {
    recentMessages: messages.slice(0, -1),
    sessionErrorMetadata: errorMetadata,
    repoSignals: repoRoutingSignals ?? undefined,
  });
  let currentExecution = await buildReasoningExecutionState(
    {
      ...options,
      provider: turnState.currentProviderName,
      modelOverride: turnState.currentModelOverride,
      effort: turnState.runtimeThinkingLevel ?? options.effort,
    },
    turnState.runtimeThinkingLevel
      ? {
        ...reasoningPlan,
        effort: turnState.runtimeThinkingLevel,
      }
      : reasoningPlan,
    messages.length === 1,
  );
  let memoryObservationSequence = 0;
  let pendingMemoryInterventionTriggers: MemoryInterventionTrigger[] = [];
  if (memoryController !== undefined && memoryPack !== undefined) {
    memorySession = await createMemoryAgent({
      controlPlane: memoryController,
      initialMemoryPack: memoryPack,
      sourcePolicy: codingMemorySourcePolicy,
      ...(options.memoryRecallRunner !== undefined
        ? { recallRunner: options.memoryRecallRunner }
        : {}),
      persistOutcomeDigest: async (digest) => {
        if (digest.visibility === 'prompt_safe'
          && options.session?.storage !== undefined
          && memoryBranchEpoch !== undefined) {
          const persisted = await persistPendingEpisodeReview(memoryIdentity, digest, {
            expectedBranchEpoch: memoryBranchEpoch,
            persistOwner: async (entry) => persistMemoryOutcomeToSession(
              options,
              sessionId,
              digest,
              { jobId: entry.jobId },
            ),
          });
          preferredMemoryReviewJobId = persisted.entry.jobId;
          return;
        }
        await persistMemoryOutcomeToSession(options, sessionId, digest);
      },
      ...(options.session?.storage === undefined && options.memoryReviewer !== undefined
        ? {
            reviewEpisode: async (digest, signal) => {
              if (memoryController === undefined) return;
              const review = await memoryController.reviewEpisode(digest, signal);
              if (signal.aborted) return;
              events.onMemoryReviewReceipt?.({
                sessionId,
                reviewKey: digest.reviewKey,
                proposalIds: review.proposalIds,
                completedAt: new Date().toISOString(),
              });
              if (review.appliedProposalIds.length > 0) {
                events.onMemoryNotice?.({
                  sessionId,
                  episodeId: digest.id,
                  summaries: review.decisions
                    .filter((decision) => (
                      decision.proposalId !== undefined
                      && review.appliedProposalIds.includes(decision.proposalId)
                    ))
                    .map((decision) => review.plan.actions[decision.actionIndex]?.summary)
                    .filter((summary): summary is string => summary !== undefined)
                    .slice(0, 3),
                  proposalIds: review.appliedProposalIds,
                });
              }
            },
          }
        : {}),
      onTrace: (event) => {
        if (event.type === 'memory.decision') {
          recordMemoryDecisionReceipt(event.receipt);
          emitResilienceDebug('[memory:decision]', {
            receiptId: event.receipt.id,
            policyVersion: event.receipt.policyVersion,
            candidateRefs: event.receipt.candidateRefs,
            selectedRefs: event.receipt.selectedRefs,
            injectedRefs: event.receipt.injectedRefs,
          });
          return;
        }
        emitResilienceDebug(`[memory:${event.type}]`, {
          key: event.key,
          detail: event.detail ?? null,
        });
      },
    }).startSession({
      identity: memoryIdentity,
      objective: prompt,
      episodeId: options.context?.learnedSkillBindingId ?? liveTurnScopeRef.current.turnId,
    });
    if (memoryRecallToolAllowed) {
      runtimeSessionState.activeTools = activateMemoryRecallTool(
        runtimeSessionState.activeTools,
        true,
      );
      ctx.memoryRecall = createMemoryRecallBinding(memorySession, () =>
        memoryDecisionBinding === undefined
          ? undefined
          : {
              decisionRevision: memoryDecisionBinding.revision,
              ...(memoryDecisionBinding.actionSignature !== undefined
                ? { actionSignature: memoryDecisionBinding.actionSignature }
                : {}),
              throughSequence: memoryDecisionBinding.throughSequence,
            });
    }
    if (memoryIntentToolAllowed) {
      runtimeSessionState.activeTools = activateMemoryIntentTool(
        runtimeSessionState.activeTools,
        true,
      );
      ctx.memoryManagementIntent = createMemoryIntentBinding({
        getCurrentUserTurn: () => memoryIntentUserTurnRef.current,
        controlPlane: memoryController,
        getPresentedTargets: () => extractPresentedMemoryTargetRefs(messages),
        onHandledOperation: (operation) => handledMemoryOperations.push(operation),
      });
    }
  }

  let incompleteRetryCount = 0;
  // CAP-085: `limitReached` flag — was a `let` toggled `true` only at
  // the iteration-limit terminal site. Folded into the literal `true`
  // at that single call site since FEATURE_100 P3.5c (substrate
  // `applyIterationLimitTerminal` owns the terminal). Other branches
  // pass `limitReached: false` literally.
  // Thin local wrapper over the CAP-053 step helper so the 8 existing
   // call sites can keep their `emitIterationEnd(iter+1, snapshot?)`
   // shape while the actual rebase + emission lives in event-emitter.ts.
  const emitIterationEnd = (
    iterNumber: number,
    snapshotOverride?: typeof contextTokenSnapshot,
  ): typeof contextTokenSnapshot => {
    contextTokenSnapshot = emitIterationEndStep(events, {
      iter: iterNumber,
      maxIter: iterationLimit,
      messages,
      currentSnapshot: contextTokenSnapshot,
      snapshotOverride,
    });
    return contextTokenSnapshot;
  };
  const currentRoutingDecision = () => reasoningPlan.decision;
  const finalizeCaughtError = async (cause: unknown): Promise<KodaXResult> => {
    options.context?.interruptInput?.closeInputWindow();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const cleanup = await runCatchCleanup({
      error,
      messages,
      errorMetadata,
      options,
      sessionId,
      title,
      runtimeSessionState,
    });
    const cleanedMessages = cleanup.cleanedMessages;
    const updatedErrorMetadata = cleanup.updatedErrorMetadata;
    contextTokenSnapshot = cleanup.contextTokenSnapshot;

    if (error instanceof ContextCapacityError) {
      throw error;
    }
    if (error.name === 'AbortError') {
      await applyAbortErrorTerminal({ events, emitActiveExtensionEvent });
      return finalizeCompletedProtocolResult({
        success: true,
        lastText: turnState.lastText,
        messages: cleanedMessages,
        sessionId,
        routingDecision: currentRoutingDecision(),
        contextTokenSnapshot,
        interrupted: true,
        errorMetadata: updatedErrorMetadata,
      });
    }

    emitLiveTurnFailedOnce(error);
    await applyGenericErrorTerminal({ error, events, emitActiveExtensionEvent });
    return finalizeManagedProtocolResult({
      success: false,
      lastText: turnState.lastText,
      messages: cleanedMessages,
      sessionId,
      routingDecision: currentRoutingDecision(),
      contextTokenSnapshot,
      errorMetadata: updatedErrorMetadata,
    });
  };
    emitSessionStart(events, { provider: initialProvider.name, sessionId });
    await emitActiveExtensionEvent('session:start', { provider: initialProvider.name, sessionId });
    emitTurnStarted(events, liveTurnScopeRef.current);

    // Cost tracking — lightweight session-scoped tracker. The closure
    // captures the stable `turnState` reference; reads see the latest
    // tracker value at call time (recordUsage produces a new value each
    // turn, written back via `turnState.costTracker = ...`).
    if (events.getCostReport) {
      events.getCostReport.current = () => formatCostReport(getSummary(turnState.costTracker));
    }

    for (let iter = 0; iter < iterationLimit; iter++) {
    try {
      if (
        options.context?.interruptInput
        && iter + 1 >= absoluteIterationLimit
      ) {
        options.context.interruptInput.closeInputWindow();
      }
      // CAP-055: per-turn provider/model/thinkingLevel re-resolution +
      // CAP-042 per-turn isConfigured check + CAP-056 contextWindow cascade.
      const turnProvider = resolvePerTurnProvider(
        runtimeSessionState,
        options,
        compactionConfig,
      );
      turnState.currentProviderName = turnProvider.providerName;
      turnState.currentModelOverride = turnProvider.modelOverride;
      turnState.runtimeThinkingLevel = turnProvider.thinkingLevel;
      const provider = turnProvider.provider;
      let contextWindow = turnProvider.contextWindow;
      let memorySuffix: KodaXEphemeralSuffix | undefined;

      // CAP-057: per-turn effectiveReasoningPlan + currentExecution rebuild.
      const turnReasoning = await resolvePerTurnReasoning({
        options,
        providerName: turnState.currentProviderName,
        modelOverride: turnState.currentModelOverride,
        thinkingLevel: turnState.runtimeThinkingLevel,
        reasoningPlan,
        messages,
      });
      const effectiveReasoningPlan = turnReasoning.effectiveReasoningPlan;
      currentExecution = turnReasoning.currentExecution;

      await emitActiveExtensionEvent('turn:start', {
        sessionId,
        iteration: iter + 1,
        maxIter: iterationLimit,
      });
      // CAP-058: user-facing iteration-start event.
      emitIterationStartStep(events, iter, iterationLimit);

      const preparedProviderState = await applyProviderPrepareHook({
        provider: turnState.currentProviderName,
        model: turnState.currentModelOverride,
        reasoningMode: effectiveReasoningPlan.effort,
        systemPrompt: currentExecution.systemPrompt,
      });
      if (preparedProviderState.blockedReason) {
        throw new Error(preparedProviderState.blockedReason);
      }
      turnState.currentProviderName = preparedProviderState.provider;
      turnState.currentModelOverride = preparedProviderState.model;
      runtimeSessionState.modelSelection.provider = turnState.currentProviderName;
      runtimeSessionState.modelSelection.model = turnState.currentModelOverride;
      turnState.runtimeThinkingLevel = preparedProviderState.reasoningMode;
      runtimeSessionState.thinkingLevel = turnState.runtimeThinkingLevel;
      const streamProvider = resolveProvider(turnState.currentProviderName);
      contextWindow = resolveContextWindow(
        compactionConfig,
        streamProvider,
        turnState.currentModelOverride,
      );

      let effectiveProviderEffort = turnState.runtimeThinkingLevel ?? effectiveReasoningPlan.effort;
      // FEATURE_222 (R5) — self-heal a hard-rejected reasoning_effort across turns.
      // base.ts fires onReasoningEffortRejected + suppresses within a turn, but the
      // provider instance is rebuilt every turn so that suppression is lost;
      // stream-handler-wiring records the rejection in the capability cache and here
      // we consult it before building the request. No relevant rejection → the effort
      // is left untouched and behavior is byte-identical.
      //
      // Keyed by the SAME concrete model base.ts records under
      // (`modelOverride ?? provider.getModel()`) — including runtime-registered
      // providers, which resolveProvider (unlike a static descriptor lookup) resolves.
      const rejectionModel = turnState.currentModelOverride ?? streamProvider.getModel();
      const rejectedEfforts = getCachedRejectedEfforts(turnState.currentProviderName, rejectionModel);
      if (effectiveProviderEffort !== undefined && rejectedEfforts.length > 0) {
        // Check the value that would actually reach the wire (the provider applies
        // effortAliases / ceilings), not the pre-alias effort — a rejected rung can be
        // reached via an alias (e.g. low → high). If that wire value is rejected,
        // re-resolve with the rejected rungs narrowed out.
        const wouldSend = resolveWireEffort({
          provider: turnState.currentProviderName,
          model: rejectionModel,
          desiredEffort: effectiveProviderEffort,
        }).effort;
        if (wouldSend !== undefined && rejectedEfforts.includes(wouldSend)) {
          const healed = resolveWireEffort({
            provider: turnState.currentProviderName,
            model: rejectionModel,
            desiredEffort: effectiveProviderEffort,
            rejectedEfforts,
          });
          effectiveProviderEffort = healed.effort ?? 'none';
        }
      }
      const effectiveProviderReasoning = {
        ...currentExecution.providerReasoning,
        enabled: effectiveProviderEffort !== 'none',
        effort: effectiveProviderEffort,
      };
      // CAP-064: provider-policy gate — throws on block status, produces
      // the effective system prompt with any policy issue notes appended.
      const { effectiveSystemPrompt } = applyProviderPolicyGate({
        providerName: turnState.currentProviderName,
        model: turnState.currentModelOverride,
        provider: streamProvider,
        prompt,
        effectiveOptions: currentExecution.effectiveOptions,
        reasoningMode: effortToLegacyReasoningMode(effectiveProviderEffort) ?? 'auto',
        taskType: effectiveReasoningPlan.decision.primaryTask,
        executionMode: effectiveReasoningPlan.decision.recommendedMode,
        baseSystemPrompt: preparedProviderState.systemPrompt,
      });
      validateInputArtifactsForModel(
        currentExecution.effectiveOptions.context?.inputArtifacts ?? [],
        {
          provider: turnState.currentProviderName,
          model: turnState.currentModelOverride,
        },
      );
      assertProviderConfigured(streamProvider, turnState.currentProviderName);

      await emitActiveExtensionEvent('provider:selected', {
        provider: turnState.currentProviderName,
        model: turnState.currentModelOverride,
      });

      // CAP-068: BoundaryTrackerSession owns the tracker + the
      // beginRequest+telemetryBoundary pairing for the 2 attempt sites
      // (main stream + non-streaming fallback). Stream-handler-wiring
      // marks deltas via session.markX delegates.
      const boundarySession = new BoundaryTrackerSession();
      const boundaryTracker = boundarySession.tracker;
      // CAP-065: per-turn resilience session — fresh recovery coordinator
      // so single-shot latches (e.g. sanitize-thinking-and-retry) reset.
      const { resilienceCfg, recoveryCoordinator } = buildResilienceSession(
        turnState.currentProviderName,
        streamProvider,
        boundaryTracker,
        options.timeouts,
      );
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs; // Issue 084: 10-min hard timeout
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs; // Issue 084: 60s idle, reset on delta
      let providerMessages = messages;
      let result!: KodaXStreamResult;
      let attempt = 0;
      const unlockedDeferredTools = getUnlockedDeferredTools(ctx);
      const resolvedActiveToolDefinitions = getActiveToolDefinitions(
        runtimeSessionState.activeTools,
        options.context?.repoIntelligenceMode,
        options.context?.managedProtocolEmission?.enabled === true,
        runtime?.hasCapabilityProvider?.('mcp') ?? !!runtime,
        options.context?.toolConstructionMode,
        unlockedDeferredTools,
        // FEATURE_221: white-label the kodax_manual description for this product.
        options.selfManual?.productName,
        options.context?.agentExecutorPlane !== undefined,
        runScopedToolDefs,
      );
      // Direct Runner children do not pass through the managed-chain
      // workflowHost gate. Keep the model-visible schema truthful: without a
      // bound host, run_workflow can only return "unavailable".
      const fullActiveToolDefinitions = ctx.workflowHost
        ? resolvedActiveToolDefinitions
        : resolvedActiveToolDefinitions.filter((tool) => tool.name !== 'run_workflow');
      const diagnosticScope = liveTurnScopeRef.current;
      const diagnosticContextIdentity = {
        contextId: diagnosticScope.contextId,
        contextKind: diagnosticScope.contextKind,
        ...(diagnosticScope.parentContextId !== undefined
          ? { parentContextId: diagnosticScope.parentContextId }
          : {}),
        ...(diagnosticScope.agentId !== undefined
          ? { agentId: diagnosticScope.agentId }
          : {}),
      };
      const promptCacheKey = resolvePromptCacheDisabled(options.disablePromptCache)
        ? undefined
        : derivePromptCacheAffinityKey({
            logicalSessionId: contextIdentitySessionId,
            ...(currentAgentId !== undefined ? { agentId: currentAgentId } : {}),
          });
      const planningBudgetSnapshotBase = createRuntimeContextBudgetSnapshot({
        sessionId,
        turnId: liveTurnScopeRef.current.turnId,
        ...diagnosticContextIdentity,
        provider: turnState.currentProviderName,
        model: turnState.currentModelOverride ?? streamProvider.getModel(),
        profile: 'report_only',
        contextWindow,
        systemPrompt: effectiveSystemPrompt,
        toolDefinitions: fullActiveToolDefinitions,
        messages: providerMessages,
      });
      const contextOptimizationProfile = selectRuntimeContextOptimizationProfile(
        planningBudgetSnapshotBase,
      );
      const planningBudgetSnapshot = {
        ...planningBudgetSnapshotBase,
        profile: contextOptimizationProfile,
      };
      const exposurePlan = planToolExposure({
        tools: fullActiveToolDefinitions,
        budget: planningBudgetSnapshot,
        profile: contextOptimizationProfile,
        bridgeAvailable: hasPortableToolBridge(fullActiveToolDefinitions),
        nativeDeferredAvailable: false,
        unlockedDeferredTools,
      });
      const activeToolDefinitions = applyToolExposurePlan(
        fullActiveToolDefinitions,
        exposurePlan,
      );
      const reservedResponseTokens = streamProvider.getEffectiveMaxOutputTokens(
        turnState.currentModelOverride,
      );
      const physicalReserveTokens = reservedResponseTokens
        + (memorySession === undefined ? 0 : MEMORY_EVIDENCE_TOKEN_RESERVE);
      const requestBudgetSnapshot = createRuntimeContextBudgetSnapshot({
        sessionId,
        turnId: liveTurnScopeRef.current.turnId,
        ...diagnosticContextIdentity,
        provider: turnState.currentProviderName,
        model: turnState.currentModelOverride ?? streamProvider.getModel(),
        profile: contextOptimizationProfile,
        contextWindow,
        systemPrompt: effectiveSystemPrompt,
        toolDefinitions: activeToolDefinitions,
        messages: providerMessages,
      });
      const currentTokens = Math.max(
        resolveContextTokenCount(messages, contextTokenSnapshot),
        requestBudgetSnapshot.usedTokens,
      );
      const needsCompact = shouldCompact({
        messages,
        compactionConfig,
        contextWindow,
        currentTokens,
        reservedResponseTokens: physicalReserveTokens,
      });
      const compactionLifecycle = await runCompactionLifecycle({
        messages,
        needsCompact,
        compactConsecutiveFailures: turnState.compactConsecutiveFailures,
        compactionConfig,
        provider: streamProvider,
        model: turnState.currentModelOverride,
        ...diagnosticContextIdentity,
        contextWindow,
        systemPrompt: effectiveSystemPrompt,
        toolDefinitions: activeToolDefinitions,
        reasoning: effectiveProviderReasoning,
        currentTokens,
        reservedResponseTokens: physicalReserveTokens,
        events,
        compactionAntiThrash: turnState.compactAntiThrash,
        emitCompactionDiagnostics: options.context?.contextDiagnostics === true,
        disablePromptCache: options.disablePromptCache,
        promptCacheKey,
      });
      messages = compactionLifecycle.messages;
      providerMessages = messages;
      turnState.compactConsecutiveFailures = compactionLifecycle.nextCompactConsecutiveFailures;
      turnState.compactAntiThrash = compactionLifecycle.nextCompactionAntiThrash;
      if (compactionLifecycle.contextTokenSnapshot !== undefined) {
        contextTokenSnapshot = compactionLifecycle.contextTokenSnapshot;
      }
      if (memorySession !== undefined) {
        const memoryContext = buildCodingMemoryContext({
          objective: prompt,
          decisionIntent: reasoningPlan.decision.primaryTask,
          actionSignature: `task:${reasoningPlan.decision.primaryTask}`,
          todoStore: ctx.todoStore,
          observationSequence: memoryObservationSequence,
        });
        memoryDecisionBinding = memoryContext;
        const triggers = [
          ...pendingMemoryInterventionTriggers,
          ...(compactionLifecycle.didCompactMessages
            ? ['context_compacted' as const]
            : []),
        ].filter((trigger, index, values) => values.indexOf(trigger) === index);
        pendingMemoryInterventionTriggers = [];
        try {
          const reminder = triggers.length > 0
            ? await memorySession.intervene({
                decisionRevision: memoryContext.revision,
                objective: prompt,
                decisionContext: memoryContext.text,
                decisionIntent: memoryContext.decisionIntent,
                actionSignature: memoryContext.actionSignature,
                throughSequence: memoryContext.throughSequence,
                triggers,
                currentCandidates: memoryContext.currentCandidates,
                ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
              })
            : iter > 0
              ? memorySession.recall({
                  decisionRevision: memoryContext.revision,
                  objective: prompt,
                  decisionContext: memoryContext.text,
                  decisionIntent: memoryContext.decisionIntent,
                  actionSignature: memoryContext.actionSignature,
                  throughSequence: memoryContext.throughSequence,
                })
              : undefined;
          if (reminder !== undefined) memorySuffix = renderMemoryReminderSuffix(reminder);
        } catch (error) {
          emitResilienceDebug('[memory:intervention:error]', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throwCallerAbort(options.abortSignal);
      const budgetSnapshot = {
        ...createRuntimeContextBudgetSnapshot({
          sessionId,
          turnId: liveTurnScopeRef.current.turnId,
          ...diagnosticContextIdentity,
          provider: turnState.currentProviderName,
          model: turnState.currentModelOverride ?? streamProvider.getModel(),
          profile: contextOptimizationProfile,
          contextWindow,
          systemPrompt: effectiveSystemPrompt,
          toolDefinitions: activeToolDefinitions,
          messages: providerMessages,
          ...(memorySuffix?.content ? { pendingInput: memorySuffix.content } : {}),
          reservedResponseTokens,
        }),
        profile: contextOptimizationProfile,
      };
      // The effective wire prompt already contains the skills addendum (or is
      // replaced wholesale by systemPromptOverride), so the final request
      // estimate consists of that prompt, active schemas, and transcript once.
      // Keep this physical-envelope baseline for providers that omit usage.
      let estimatedRequestTokenSnapshot = {
        ...createContextTokenSnapshot(providerMessages),
        currentTokens: Math.max(
          resolveContextTokenCount(providerMessages, contextTokenSnapshot),
          budgetSnapshot.usedTokens - budgetSnapshot.tokenBreakdown.reservedResponse,
        ),
      };
      const shouldEmitContextDiagnostics =
        options.context?.contextDiagnostics === true
        && (events.onContextBudgetSnapshot !== undefined || events.onToolExposurePlanned !== undefined);
      if (shouldEmitContextDiagnostics) {
        events.onToolExposurePlanned?.({
          ...exposurePlan,
          ...diagnosticContextIdentity,
        });
      }
      const emitContextBudgetSnapshot = (
        currentProviderMessages: readonly KodaXMessage[],
        requestReservedResponseTokens = reservedResponseTokens,
      ): void => {
        if (
          options.context?.contextDiagnostics !== true
          || events.onContextBudgetSnapshot === undefined
        ) {
          return;
        }
        try {
          events.onContextBudgetSnapshot({
            ...createRuntimeContextBudgetSnapshot({
              sessionId,
              turnId: liveTurnScopeRef.current.turnId,
              ...diagnosticContextIdentity,
              provider: turnState.currentProviderName,
              model: turnState.currentModelOverride ?? streamProvider.getModel(),
              profile: contextOptimizationProfile,
              contextWindow,
              systemPrompt: effectiveSystemPrompt,
              toolDefinitions: activeToolDefinitions,
              messages: currentProviderMessages,
              ...(memorySuffix?.content ? { pendingInput: memorySuffix.content } : {}),
              reservedResponseTokens: requestReservedResponseTokens,
            }),
            profile: contextOptimizationProfile,
          });
        } catch (error) {
          emitResilienceDebug('[context-diagnostics:budget-callback-error]', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const responseId = liveTurnScopeRef.current.turnId;
      let nextOutputSegmentMode: 'append' | 'replace' = 'append';
      let activeProviderRequestId: string | undefined;
      // FEATURE_296 T5/T6 (ADR-067): `wireMessages` is the request-only view
      // the provider receives — irreducibly oversized user inputs degraded to
      // preview + run-scoped pointer — while `providerMessages` keeps the
      // originals for every `messages =` transcript alias below. The
      // wire-level output reserve shrinks floor-bounded while the assembled
      // request is over capacity, so the provider request is legal; a
      // rejection routes to classification, never a resend.
      let wireMessages = await degradeIrreducibleUserInputs(
        providerMessages,
        ctx,
        contextWindow,
        userInputDegradationCache,
      );
      const requestMaxOutputTokens = applyContextCapacityReserveOverride(streamProvider, {
        ...(turnState.currentModelOverride !== undefined
          ? { model: turnState.currentModelOverride }
          : {}),
        contextWindow,
        currentTokens: resolveContextTokenCount(wireMessages, contextTokenSnapshot),
      });
      while (true) {
        attempt += 1;
        // Recovery may replace providerMessages between attempts. Rebase the
        // same fixed request overhead onto the exact messages sent next.
        estimatedRequestTokenSnapshot = rebaseContextTokenSnapshot(
          wireMessages,
          estimatedRequestTokenSnapshot,
        );
        const providerRequestId = boundarySession.beginAttempt(
          turnState.currentProviderName,
          turnState.currentModelOverride ?? streamProvider.getModel(),
          wireMessages,
          attempt,
          false,
        );
        activeProviderRequestId = providerRequestId;
        events.onOutputSegmentStart?.({
          responseId,
          providerRequestId,
          mode: nextOutputSegmentMode,
        });
        nextOutputSegmentMode = 'replace';

        // CAP-066: stream-timer lifecycle (hard / max-duration / idle +
        // merged retrySignal). All three timers fire into a single
        // retryTimeoutController; clearAll() must run on every exit.
        const streamTimers = buildStreamTimers({
          hardTimeoutMs: API_HARD_TIMEOUT_MS,
          idleTimeoutMs: API_IDLE_TIMEOUT_MS,
          streamMaxDurationMs:
            streamProvider.getStreamMaxDurationMs?.(turnState.currentModelOverride) ?? 0,
          callerAbortSignal: options.abortSignal,
        });
        const retryTimeoutController = streamTimers.retryTimeoutController;
        const retrySignal = streamTimers.retrySignal;
        const resetIdleTimer = streamTimers.resetIdleTimer;

        const payloadBytes = estimateProviderPayloadBytes(wireMessages, effectiveSystemPrompt);
        emitResilienceDebug('[resilience:request]', {
          provider: turnState.currentProviderName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
          lastToolErrorCode: runtimeSessionState.lastToolErrorCode,
          lastToolResultBytes: runtimeSessionState.lastToolResultBytes,
        });

        try {
          // CAP-067: build the 6-handler callback bag (delta / thinking-end /
          // tool-input / rate-limit / heartbeat). All handlers fan out to
          // streamTimers.resetIdleTimer() + boundaryTracker + extension
          // events + consumer events in load-bearing order.
          const streamCallbacks = buildStreamHandlers({
            events: attributeProviderRequest(events, providerRequestId),
            boundaryTracker,
            streamTimers,
            emitActiveExtensionEvent,
            providerName: turnState.currentProviderName,
          });
          // FEATURE_130 (v0.7.36): wrap the structured retry-after
          // callback so the per-session cost tracker accumulates retry
          // counts and total wait time. The wrapper still forwards to
          // `events.onRetryAfter` (already handled by buildStreamHandlers)
          // — this layer only adds the tracker write.
          const wrappedRetryAfter: typeof streamCallbacks.onRetryAfter = (event) => {
            turnState.costTracker = recordRetry(turnState.costTracker, {
              provider: event.provider,
              waitMs: event.waitMs,
              reason: event.reason,
              source: event.source,
            });
            streamCallbacks.onRetryAfter?.(event);
          };
          emitContextBudgetSnapshot(wireMessages, requestMaxOutputTokens);
          const cacheDiagnostic = emitPromptCacheDiagnosticRequest({
            events,
            enabled: options.context?.contextDiagnostics === true,
            provider: streamProvider,
            providerName: turnState.currentProviderName,
            ...diagnosticContextIdentity,
            model: turnState.currentModelOverride ?? streamProvider.getModel(),
            reasoning: effectiveProviderReasoning,
            disablePromptCache: options.disablePromptCache,
            system: effectiveSystemPrompt,
            tools: activeToolDefinitions,
            messages: wireMessages,
            ...(memorySuffix !== undefined ? { ephemeralSuffix: memorySuffix } : {}),
            ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
            attempt,
          });
          result = await streamProvider.stream(
            wireMessages,
            activeToolDefinitions,
            effectiveSystemPrompt,
            effectiveProviderReasoning,
            {
              ...streamCallbacks,
              promptCacheKey,
              onRetryAfter: wrappedRetryAfter,
              modelOverride: turnState.currentModelOverride,
              maxOutputTokensOverride: requestMaxOutputTokens,
              ephemeralSuffix: memorySuffix,
              signal: retrySignal,
            },
            retrySignal,
          );
          emitPromptCacheDiagnosticResponse(events, cacheDiagnostic, result.usage);

          messages = providerMessages;
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          // CAP-070: translate timer-driven AbortError into KodaXNetworkError
          // so the recovery pipeline treats it as a stalled-stream rather
          // than a clean user-cancel. User-driven aborts pass through.
          error = await translateAbortError(error, retryTimeoutController, options.abortSignal);

          // CAP-069: classify → decide → emit (onProviderRecovery + onRetry).
          const failureStage = boundarySession.inferFailureStage();
          const { decision } = runRecoveryPipeline({
            error,
            failureStage,
            attempt,
            events,
            resilienceCfg,
            recoveryCoordinator,
          });

          if (decision.shouldUseNonStreaming) {
            const fallbackBytes = estimateProviderPayloadBytes(wireMessages, effectiveSystemPrompt);
            emitResilienceDebug('[resilience:fallback]', {
              provider: turnState.currentProviderName,
              attempt,
              payloadBytes: fallbackBytes,
              payloadBucket: bucketProviderPayloadSize(fallbackBytes),
            });

            // CAP-071: non-streaming fallback. On success, the outer
            // attempt loop must `break` with the buffered result. On
            // failure, fall through to recovery-action branches with
            // the new error.
            emitContextBudgetSnapshot(wireMessages, requestMaxOutputTokens);
            const fallbackCacheDiagnostic = emitPromptCacheDiagnosticRequest({
              events,
              enabled: options.context?.contextDiagnostics === true,
              provider: streamProvider,
              providerName: turnState.currentProviderName,
              ...diagnosticContextIdentity,
              model: turnState.currentModelOverride ?? streamProvider.getModel(),
              reasoning: effectiveProviderReasoning,
              disablePromptCache: options.disablePromptCache,
              system: effectiveSystemPrompt,
              tools: activeToolDefinitions,
              messages: wireMessages,
              ...(memorySuffix !== undefined ? { ephemeralSuffix: memorySuffix } : {}),
              ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
              attempt,
              transport: 'complete',
            });
            const fallbackOutcome = await executeNonStreamingFallback({
              events,
              streamProvider,
              providerMessages: wireMessages,
              activeToolDefinitions,
              effectiveSystemPrompt,
              effectiveProviderReasoning,
              callerAbortSignal: options.abortSignal,
              promptCacheKey,
              modelOverride: turnState.currentModelOverride,
              maxOutputTokensOverride: requestMaxOutputTokens,
              ephemeralSuffix: memorySuffix,
              hardTimeoutMs: API_HARD_TIMEOUT_MS,
              boundarySession,
              emitActiveExtensionEvent,
              providerName: turnState.currentProviderName,
              attempt,
              responseId,
              clearStreamTimers: streamTimers.clearAll,
            });
            if (fallbackOutcome.ok) {
              result = fallbackOutcome.result;
              activeProviderRequestId = fallbackOutcome.providerRequestId;
              emitPromptCacheDiagnosticResponse(
                events,
                fallbackCacheDiagnostic,
                result.usage,
              );
              messages = providerMessages;
              break;
            }
            // Fallback failed — reassign `error` and fall through to the
            // sanitize_thinking_and_retry / manual_continue / retry-delay
            // branches below. Note: the original `decision` is reused; we
            // do NOT re-classify the post-fallback error. This matches
            // pre-FEATURE_100 baseline behavior — the design choice is that
            // a failed fallback represents the same failure class as the
            // streaming attempt that triggered it (rate-limit / network /
            // stream incomplete), not a new error class. If a future
            // provider.complete starts throwing thinking-mode errors that
            // would benefit from sanitize_thinking_and_retry, this branch
            // will need a second runRecoveryPipeline pass — flagged in
            // P3.2 holistic review (deferred to integration testing).
            error = fallbackOutcome.error;
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) gated by
          // its own latch inside the coordinator. Bypass the maxRetries
          // gate so it can fire even when normal retries are exhausted.
          // Mirrors the runner-driven path at runner-driven.ts:2654.
          //
          // The mirror is intentional, not migration debt: this file is
          // the SA-mode substrate body and runner-driven.ts is the AMA-mode
          // path (V2 Worker single-loop after FEATURE_193 retired the V1
          // Scout/Planner/Generator/Evaluator chain). They are two parallel
          // execution modes dispatched by `task-engine.ts:dispatchManagedTask`,
          // sharing the same provider stack and therefore seeing the same
          // thinking-mode errors. Per CLAUDE.md "abstract only after 3+
          // real cases", 2 call sites stay duplicated. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            wireMessages = await degradeIrreducibleUserInputs(
              providerMessages,
              ctx,
              contextWindow,
              userInputDegradationCache,
            );
            streamTimers.clearAll();
            // Don't bill a retry slot for the sanitize step.
            attempt -= 1;
            await waitForRetryDelay(decision.delayMs, options.abortSignal);
            continue;
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            messages = providerMessages;
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;
          wireMessages = await degradeIrreducibleUserInputs(
            providerMessages,
            ctx,
            contextWindow,
            userInputDegradationCache,
          );

          streamTimers.clearAll();
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          streamTimers.clearAll();
        }
      }

      // 流式输出结束，通知 CLI 层
      emitStreamEnd(events);
      await emitActiveExtensionEvent('stream:end', undefined);

      // Record cost for this LLM call
      if (result.usage) {
        turnState.costTracker = recordUsage(turnState.costTracker, {
          provider: turnState.currentProviderName,
          model: turnState.currentModelOverride ?? 'unknown',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        });
      }

      turnState.lastText = result.textBlocks.map(b => b.text).join(' ');
      const reportedPreAssistantTokenSnapshot = createContextTokenSnapshot(messages, result.usage);
      const preAssistantTokenSnapshot = reportedPreAssistantTokenSnapshot.source === 'api'
        ? reportedPreAssistantTokenSnapshot
        : rebaseContextTokenSnapshot(messages, estimatedRequestTokenSnapshot);

      // Conservative tool-name repair ONCE per turn (`Write` → `write`), before
      // ANY consumer reads `result.toolBlocks` — history (assistant message),
      // dispatch (bash sequential-vs-parallel routing keys on `name==='bash'`),
      // tool events, and the incomplete-tool param scan — so the canonical name
      // is used uniformly and `tool:start`/`tool:result` cannot disagree.
      // Unique case/separator match only; never edit-distance. See tool-name-repair.ts.
      const activeToolNamesForTurn = getRuntimeActiveToolNames(
        runtimeSessionState.activeTools,
        options.context?.repoIntelligenceMode,
        runtime?.hasCapabilityProvider?.('mcp') ?? !!runtime,
        options.context?.toolConstructionMode,
        options.context?.agentExecutorPlane !== undefined,
      );
      result = { ...result, toolBlocks: repairToolBlockNames(result.toolBlocks, activeToolNamesForTurn) };

      const visibleToolBlocks = result.toolBlocks.filter((block) => isVisibleToolName(block.name));

      // Promise 信号检测
      const [rawSignal, _reason] = checkPromiseSignal(turnState.lastText);
      const signal = rawSignal === 'COMPLETE'
        || rawSignal === 'BLOCKED'
        || rawSignal === 'DECIDE'
        ? rawSignal
        : undefined;
      if (
        result.toolBlocks.length === 0
        || signal === 'COMPLETE'
        || iter + 1 >= iterationLimit
      ) {
        options.context?.interruptInput?.closeInputWindow();
      }
      if (signal && signal !== 'COMPLETE') {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
          signal,
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(messages, runtimeSessionState);
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        if (appendedQueuedMessages || consumedInterruptInput) {
          const hasContinuationIteration = consumedInterruptInput
            ? reserveInterruptContinuation(iter)
            : iter + 1 < iterationLimit;
          if (hasContinuationIteration && canReopenInterruptInput(iter)) {
            options.context?.interruptInput?.reopenInputWindow();
          }
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal,
          });
          continue;
        }
      }

      // Removed: L1 max_tokens escalation (was: same-turn retry at 64K
      // when capped budget returned stop_reason:max_tokens). Three forces
      // converged to drop it:
      //   1. partial-json salvage in anthropic.ts (P0) preserves the
      //      truncated tool_use input so escalation's "discard the turn"
      //      premise no longer holds — discarding throws away salvaged work.
      //   2. Bench (2026-04, kimi-code/mimo-coding/minimax-coding M2.7 all
      //      complete 64K stream cleanly at 460-525s) confirmed escalation
      //      paths through 32K → 64K were never end-to-end tested in CI;
      //      relying on them for production was undertested.
      //   3. opencode and pi-mono (the two industry references for
      //      multi-provider coding agents) do not escalate — only Claude
      //      Code does, and that's tuned to Anthropic's own infrastructure.
      // Behavior change: max_tokens now always falls through to assistant
      // commit + L5 continuation meta below. KODAX_ESCALATED_MAX_OUTPUT_TOKENS
      // remains a public constant in case external callers want to opt in
      // via direct provider override, but the agent loop no longer wires it.

      // CAP-073: empty-content guard — if the model emitted only invisible
      // tool calls (e.g. hidden todo tools) with no text/thinking, replace the
      // empty array with a single EMPTY text-block marker ({ text: '' }) so the
      // turn stays well-formed without persisting a fake '...' reply. The
      // provider serializer synthesizes a wire-only '...' if the gateway
      // (e.g. Kimi 400 "must not be empty") rejects empty content.
      const assistantContent = guardEmptyAssistantContent([
        ...result.thinkingBlocks,
        ...result.textBlocks,
        ...(signal === 'COMPLETE' ? [] : visibleToolBlocks),
      ]);
      // GOAL 2: stamp when the LLM stream completed so the session entry carries
      // a real per-message time (SA path; parallel to runner.ts). Additive.
      messages.push({
        role: 'assistant',
        content: assistantContent,
        turnId: liveTurnScopeRef.current.turnId,
        timestamp: new Date().toISOString(),
      });
      const reportedCompletedTurnTokenSnapshot = createCompletedTurnTokenSnapshot(
        messages,
        result.usage,
      );
      let completedTurnTokenSnapshot = reportedCompletedTurnTokenSnapshot.source === 'api'
        ? reportedCompletedTurnTokenSnapshot
        : rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
      contextTokenSnapshot = completedTurnTokenSnapshot;

      if (signal === 'COMPLETE') {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
          signal: 'COMPLETE',
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(
          messages,
          runtimeSessionState,
        );
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        if (appendedQueuedMessages || consumedInterruptInput) {
          const hasContinuationIteration = consumedInterruptInput
            ? reserveInterruptContinuation(iter)
            : iter + 1 < iterationLimit;
          if (hasContinuationIteration && canReopenInterruptInput(iter)) {
            options.context?.interruptInput?.reopenInputWindow();
          }
          contextTokenSnapshot = rebaseContextTokenSnapshot(
            messages,
            completedTurnTokenSnapshot,
          );
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: 'COMPLETE',
          });
          continue;
        }
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: false,
          signal: 'COMPLETE',
        });
        await emitActiveExtensionEvent('complete', { success: true, signal: 'COMPLETE' });
        return finalizeCompletedProtocolResult({
          success: true,
          lastText: turnState.lastText,
          signal: 'COMPLETE',
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          limitReached: false,
        });
      }

      // L5 continuation: max_tokens hit and no tool was emitted (so the
      // model was producing pure text and got cut mid-thought). Inject a
      // Claude-Code-style recovery meta message instructing the model to
      // resume mid-thought and break remaining work into smaller pieces
      // (so a too-large Write becomes Write+Edit across turns). Capped at
      // KODAX_MAX_MAXTOKENS_RETRIES (3) to prevent infinite loops.
      //
      // Skipped when tool_use blocks are present: the tool-execution /
      // incomplete-tool-retry path already handles them — complete calls
      // execute, while a truncated or salvaged-mutating call is routed into
      // the bounded retry (ADR-045), not executed. The max_tokens text nudge
      // is not needed for that path.
      // CAP-074: L5 max_tokens continuation. Synthetic "resume mid-thought"
      // user message capped at KODAX_MAX_MAXTOKENS_RETRIES; skipped when
      // tool_blocks are present (partial-JSON salvage handles those naturally).
      const maxTokensOutcome = maybeContinueAfterMaxTokens({
        result,
        messages,
        maxTokensRetryCount: turnState.maxTokensRetryCount,
        completedTurnTokenSnapshot,
        events: activeProviderRequestId
          ? attributeProviderRequest(events, activeProviderRequestId)
          : events,
      });
      turnState.maxTokensRetryCount = maxTokensOutcome.nextMaxTokensRetryCount;
      if (maxTokensOutcome.outcome === 'continue') {
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        const hasContinuationIteration = consumedInterruptInput
          ? reserveInterruptContinuation(iter)
          : iter + 1 < iterationLimit;
        if (hasContinuationIteration && canReopenInterruptInput(iter)) {
          options.context?.interruptInput?.reopenInputWindow();
        }
        contextTokenSnapshot = consumedInterruptInput
          ? rebaseContextTokenSnapshot(
              messages,
              maxTokensOutcome.nextContextTokenSnapshot,
            )
          : maxTokensOutcome.nextContextTokenSnapshot;
        continue;
      }

      // CAP-075: Fallback auto-continue when end_turn fires but the
      // required managed-protocol block is missing. Single-shot per
      // session — the latch round-trips via input/output.
      const protocolContinueOutcome = maybeAutoContinueManagedProtocol({
        result,
        lastText: turnState.lastText,
        messages,
        continueAttempted: turnState.managedProtocolContinueAttempted,
        options,
        emittedManagedProtocolPayload: managedProtocolPayloadRef.current,
        completedTurnTokenSnapshot,
      });
      turnState.managedProtocolContinueAttempted = protocolContinueOutcome.nextContinueAttempted;
      if (protocolContinueOutcome.outcome === 'continue') {
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        const hasContinuationIteration = consumedInterruptInput
          ? reserveInterruptContinuation(iter)
          : iter + 1 < iterationLimit;
        if (hasContinuationIteration && canReopenInterruptInput(iter)) {
          options.context?.interruptInput?.reopenInputWindow();
        }
        contextTokenSnapshot = consumedInterruptInput
          ? rebaseContextTokenSnapshot(
              messages,
              protocolContinueOutcome.nextContextTokenSnapshot,
            )
          : protocolContinueOutcome.nextContextTokenSnapshot;
        continue;
      }

      const stopClass = classifyStopReason(result.stopReason);
      if (stopClass === 'refused') {
        events.onTextDelta?.(
          '\n\n[model declined to answer]\n\n',
          activeProviderRequestId ? { providerRequestId: activeProviderRequestId } : undefined,
        );
      } else if (stopClass === 'unknown' && typeof result.stopReason === 'string') {
        emitKodaXDiagnostic({
          source: 'coding:stop-reason',
          level: 'warn',
          message: 'Provider returned an unknown stop reason.',
          detail: {
            rawStopReason: result.stopReason,
            provider: turnState.currentProviderName,
            model: turnState.currentModelOverride ?? streamProvider.getModel(),
            hasToolBlocks: result.toolBlocks.length > 0,
            hasTextBlocks: result.textBlocks.length > 0,
          },
        });
      }

      if (result.toolBlocks.length === 0) {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(
          messages,
          runtimeSessionState,
        );
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        if (appendedQueuedMessages || consumedInterruptInput) {
          const hasContinuationIteration = consumedInterruptInput
            ? reserveInterruptContinuation(iter)
            : iter + 1 < iterationLimit;
          if (hasContinuationIteration && canReopenInterruptInput(iter)) {
            options.context?.interruptInput?.reopenInputWindow();
          }
          await commitActorNotificationReceipts(ctx, messages);
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(
          events,
          messageQueueAgentId,
        );
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeCompletedProtocolResult({
            success: true,
            lastText: turnState.lastText,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }

        // CAP-019 (auto-reroute depth-escalation + task-reroute) retired —
        // reasoning is single-track effort now; no harness-level auto-upgrade
        // (matches Codex / Claude Code, which fix effort per turn).
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        // CAP-085 (clean-exit variant): natural completion path. We still
        // run the iter-terminal helper so the final snapshot save + signal
        // extraction match the pre-FEATURE_100 byte-for-byte behavior, but
        // return with `limitReached: false` — this is a model-driven
        // completion, NOT iteration-budget exhaustion. The explicit `false`
        // flag previously kept the (since-deleted) `scout-signals.ts`
        // budget-exhausted detection from mis-tagging this turn; FEATURE_193
        // V1 cleanup retired that consumer but the flag is preserved as the
        // canonical signal-extraction contract for future consumers.
        {
          const iterTerminal = await applyIterationLimitTerminal({
            options,
            sessionId,
            messages,
            title,
            runtimeSessionState,
            lastText: turnState.lastText,
          });
          return finalizeCompletedProtocolResult({
            success: true,
            lastText: turnState.lastText,
            signal: iterTerminal.finalSignal,
            signalReason: iterTerminal.finalReason,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }
      }

      // CAP-072: incomplete-tool-call truncation retry. Single-shot-then-degrade
      // recovery: under cap → pop assistant + push synthetic user prompt and
      // retry; at cap → push error tool_results for missing-param tools and
      // continue the loop; no incomplete → reset counter and fall through.
      const incompleteRetryResult = await checkAndRetryIncompleteTools({
        toolBlocks: result.toolBlocks,
        events,
        emitActiveExtensionEvent,
        messages,
        incompleteRetryCount,
        preAssistantTokenSnapshot,
        completedTurnTokenSnapshot,
      });
      incompleteRetryCount = incompleteRetryResult.nextIncompleteRetryCount;
      contextTokenSnapshot = incompleteRetryResult.nextContextTokenSnapshot;
      if (incompleteRetryResult.outcome !== 'no_incomplete') {
        continue;
      }

      // 执行工具
      let toolResults: KodaXToolResultBlock[] = [];
      let editRecoveryMessages: string[] = [];

      // CAP-076: pre-tool abort check. If Ctrl+C fired between stream
      // end and tool dispatch, synthesize cancelled tool_results for
      // every visible tool — graceful cancellation routes through the
      // same `hasCancelledToolResult` (CAP-080) terminal as user-aborted
      // bash loops, so the exit path is uniform.
      const preToolCancelled = await checkPreToolAbort({
        toolBlocks: result.toolBlocks,
        abortSignal: options.abortSignal,
        events,
        emitActiveExtensionEvent,
      });

      if (preToolCancelled !== null) {
        // Pre-tool aborts skip the post-processing chain (CAP-078) — outcome
        // tracking, mutation reflection, and edit recovery are intentionally
        // not run for cancelled-before-dispatch tools (parity preserved from
        // the pre-FEATURE_100 inline branch).
        toolResults.push(...preToolCancelled);
      } else {
        const toolResultCurrentTokens = resolveContextTokenCount(
          messages,
          contextTokenSnapshot,
        );
        const toolResultBudget = buildToolResultBudgetFromUsage({
          contextWindow,
          currentTokens: toolResultCurrentTokens,
          reservedResponseTokens: streamProvider.getEffectiveMaxOutputTokens(
            turnState.currentModelOverride,
          ),
        });
        // CAP-077: parallel non-bash / sequential bash dispatch. Results stay
        // raw until visibility filtering and mutation reflection finish.
        const previousToolResultCapacity = ctx.toolResultCapacityTokens;
        const previousArtifactRecorder = ctx.recordToolResultArtifact;
        const toolResultArtifactPaths = new Map<string, string>();
        ctx.maximumInputTokens = toolResultCurrentTokens + toolResultBudget.aggregateInlineTokens;
        ctx.toolResultCapacityTokens = toolResultBudget.aggregateInlineTokens;
        ctx.recordToolResultArtifact = (toolCallId, outputPath) => {
          toolResultArtifactPaths.set(toolCallId, outputPath);
          previousArtifactRecorder?.(toolCallId, outputPath);
        };
        let resultMap: Map<string, string>;
        try {
          resultMap = await runToolDispatch({
            toolBlocks: result.toolBlocks,
            events,
            ctx,
            runtimeSessionState,
            activeToolNames: activeToolNamesForTurn,
            abortSignal: options.abortSignal,
            ...(toolGuardrails.length > 0 && guardrailAgent !== undefined
              ? {
                  toolGuardrails,
                  guardrailContext: {
                    agent: guardrailAgent,
                    ...(options.abortSignal !== undefined
                      ? { abortSignal: options.abortSignal }
                      : {}),
                    messages: messages.slice(0, -1),
                    permissionIntent: options.context?.permissionIntent,
                  },
                  getAfterGuardrailContext: () => ({
                    agent: guardrailAgent,
                    ...(options.abortSignal !== undefined
                      ? { abortSignal: options.abortSignal }
                      : {}),
                    messages: [...messages],
                    permissionIntent: options.context?.permissionIntent,
                  }),
                  onToolCallsPrepared: (preparedBlocks: readonly KodaXToolUseBlock[]) => {
                    if (!preparedBlocks.some((block, index) => {
                      const original = result.toolBlocks[index];
                      return original === undefined
                        || block.name !== original.name
                        || block.input !== original.input;
                    })) return;
                    result = { ...result, toolBlocks: [...preparedBlocks] };
                    replaceLatestAssistantToolBlocks(messages, result);
                    completedTurnTokenSnapshot = rebaseContextTokenSnapshot(
                      messages,
                      preAssistantTokenSnapshot,
                    );
                    contextTokenSnapshot = completedTurnTokenSnapshot;
                  },
                }
              : {}),
          });
        } finally {
          if (previousToolResultCapacity === undefined) delete ctx.toolResultCapacityTokens;
          else ctx.toolResultCapacityTokens = previousToolResultCapacity;
          if (previousArtifactRecorder === undefined) delete ctx.recordToolResultArtifact;
          else ctx.recordToolResultArtifact = previousArtifactRecorder;
        }
        // CAP-078 + CAP-079: form the final visible batch, then admit that
        // physical transcript payload against the one aggregate capacity.
        const postProcessed = await applyPostToolProcessing({
          toolBlocks: result.toolBlocks,
          resultMap,
          events,
          emitActiveExtensionEvent,
          ctx,
          runtimeSessionState,
          toolResultBudget,
          toolResultArtifactPaths,
        });
        toolResults = postProcessed.toolResults;
        editRecoveryMessages = postProcessed.editRecoveryMessages;
        if (memorySession !== undefined) {
          const observations = buildToolMemoryObservations({
            toolBlocks: result.toolBlocks,
            toolResults,
            startSequence: memoryObservationSequence,
            observedAt: new Date().toISOString(),
            ...(memoryDecisionBinding?.actionSignature !== undefined
              ? { decisionActionSignature: memoryDecisionBinding.actionSignature }
              : {}),
          });
          for (const observation of observations) memorySession.observe(observation);
          memoryObservationSequence = observations.at(-1)?.sequence ?? memoryObservationSequence;
          for (const observation of observations) {
            if (observation.metadata?.failed !== true) continue;
            const trigger: MemoryInterventionTrigger =
              observation.metadata.verification === true
                ? 'verification_failure'
                : 'tool_failure';
            if (!pendingMemoryInterventionTriggers.includes(trigger)) {
              pendingMemoryInterventionTriggers.push(trigger);
            }
          }
        }
      }

      // CAP-080: any cancelled tool result triggers the cancellation
      // terminal branch below. Pre-tool aborts (CAP-076) and bash-loop
      // mid-execution aborts (CAP-077) both surface here.
      const hasCancellation = hasCancelledToolResult(toolResults);

      if (toolResults.length === 0) {
        options.context?.interruptInput?.closeInputWindow();
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(
          messages,
          runtimeSessionState,
        );
        const consumedInterruptInput = await consumeRuntimeInterruptInput();
        if (appendedQueuedMessages || consumedInterruptInput) {
          const hasContinuationIteration = consumedInterruptInput
            ? reserveInterruptContinuation(iter)
            : iter + 1 < iterationLimit;
          if (hasContinuationIteration && canReopenInterruptInput(iter)) {
            options.context?.interruptInput?.reopenInputWindow();
          }
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(
          events,
          messageQueueAgentId,
        );
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeCompletedProtocolResult({
            success: true,
            lastText: turnState.lastText,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        // CAP-085 (clean-exit variant): natural completion path after a
        // tool turn returned no tool_use blocks. Same routing as the
        // text-only break above — run the iter-terminal helper for
        // snapshot save + signal extraction, return with
        // `limitReached: false` so the canonical signal-extraction
        // contract continues to mark this as a model-driven completion
        // (the former `scout-signals.ts` budget-exhausted consumer was
        // retired in FEATURE_193 V1 cleanup; the flag is preserved as
        // the contract anchor).
        {
          const iterTerminal = await applyIterationLimitTerminal({
            options,
            sessionId,
            messages,
            title,
            runtimeSessionState,
            lastText: turnState.lastText,
          });
          return finalizeCompletedProtocolResult({
            success: true,
            lastText: turnState.lastText,
            signal: iterTerminal.finalSignal,
            signalReason: iterTerminal.finalReason,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }
      }

      if (hasCancellation) {
        options.context?.interruptInput?.closeInputWindow();
        // CAP-080: cancellation terminal — push results, fire turn:end +
        // stream:end, return KodaXResult with interrupted flag derived
        // from queued-follow-up presence.
        const cancellationTerminal = await applyCancellationTerminal({
          events,
          emitActiveExtensionEvent,
          messages,
          toolResults,
          completedTurnTokenSnapshot,
          sessionId,
          queueAgentId: messageQueueAgentId,
          iter,
          emitIterationEnd,
        });
        contextTokenSnapshot = cancellationTerminal.contextTokenSnapshot;
        return finalizeCompletedProtocolResult({
          success: true,
          lastText: CANCELLATION_LAST_TEXT,
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          interrupted: !cancellationTerminal.shouldYieldToQueuedFollowUp,
        });
      }

      // CAP-081: push toolResults (+ recovery messages) into history,
      // rebase the snapshot, settle, drain the queue. If the drain
      // surfaced new messages, the helper emits `turn:end` itself and
      // we `continue` to consume them in the next iteration.
      const settleOutcome = await pushToolResultsAndSettle({
        messages,
        toolResults,
        editRecoveryMessages,
        completedTurnTokenSnapshot,
        runtimeSessionState,
        emitActiveExtensionEvent,
        sessionId,
        lastText: turnState.lastText,
        iter,
      });
      await commitActorNotificationReceipts(ctx, messages);
      contextTokenSnapshot = settleOutcome.contextTokenSnapshot;
      const consumedInterruptInput = await consumeRuntimeInterruptInput();
      if (consumedInterruptInput) {
        reserveInterruptContinuation(iter);
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, contextTokenSnapshot);
      }
      if (settleOutcome.drainedQueuedMessages || consumedInterruptInput) {
        if (canReopenInterruptInput(iter)) {
          options.context?.interruptInput?.reopenInputWindow();
        }
        if (settleOutcome.drainedQueuedMessages) {
          continue;
        }
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        continue;
      }
      const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(
        events,
        messageQueueAgentId,
      );
      if (shouldYieldToQueuedFollowUp) {
        emitIterationEnd(iter + 1, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        return finalizeCompletedProtocolResult({
          success: true,
          lastText: turnState.lastText,
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          limitReached: false,
        });
      }

      // CAP-019 post-tool auto-reroute retired (see above).

      // 保存会话
      // v0.7.45 fix — explicitly thread context.gitRoot so in-process
      // embedders (KodaX Space) tag the snapshot with the actual project
      // the user opened, not the host process's startup directory.
      // Matches runner-driven.ts:407/1786 convention.
      await saveSessionSnapshot(options, sessionId, {
        messages,
        title,
        gitRoot: options.context?.gitRoot ?? undefined,
        runtimeSessionState,
      });

      // Notify UI of context usage after each iteration
      emitIterationEnd(iter + 1, contextTokenSnapshot);
      await emitActiveExtensionEvent('turn:end', {
        sessionId,
        iteration: iter + 1,
        lastText: turnState.lastText,
        hadToolCalls: true,
        signal: undefined,
      });
    } catch (e) {
      return finalizeCaughtError(e);
    }
  }

  // CAP-085: iteration-limit terminal — natural for-loop exhaustion.
  // Runs the final snapshot save + signal extraction; the caller wraps
  // with `finalizeCompletedProtocolResult` and returns with
  // `limitReached: true`. This branch is reached ONLY when every iter
  // is consumed without an early `return`. The two model-driven
  // completion paths (text-only turn, tools-with-no-results turn) also
  // call `applyIterationLimitTerminal` to preserve the snapshot+signal
  // side effects byte-for-byte, but return with `limitReached: false`
  // — see the completion call sites above.
  options.context?.interruptInput?.closeInputWindow();
  const iterTerminal = await applyIterationLimitTerminal({
    options,
    sessionId,
    messages,
    title,
    runtimeSessionState,
    lastText: turnState.lastText,
  });
  try {
    await emitActiveExtensionEvent('complete', {
      success: true,
      signal: iterTerminal.finalSignal || undefined,
    });
  } catch (error) {
    return finalizeCaughtError(error);
  }
  return finalizeCompletedProtocolResult({
    success: true,
    lastText: turnState.lastText,
    signal: iterTerminal.finalSignal,
    signalReason: iterTerminal.finalReason,
    messages,
    sessionId,
    routingDecision: currentRoutingDecision(),
    contextTokenSnapshot,
    limitReached: true,
  });
  } finally {
    await cleanupUserInputDegradationCache(userInputDegradationCache);
    releaseActiveRootQueueRoute?.();
    releaseRuntimeBinding?.();
    releaseActiveExecutionRuntime();
    if (didSetActiveRuntime) {
      setActiveExtensionRuntime(previousActiveRuntime);
    }
  }
}

// `buildAutoRepoIntelligenceContext` body lives in
// `agent-runtime/middleware/repo-intelligence.ts` since FEATURE_100 P2.
// Imported above for the in-file call site at `buildReasoningExecutionState`,
// and re-exported so `runner-driven.ts:64` keeps working unchanged.

// CAP-052 (`buildReasoningExecutionState`) lives in
// `agent-runtime/reasoning-plan-entry.ts` since FEATURE_100 P2.
// Imported above for the 4 call sites: initial frame entry, every
// reroute apply, and as the `buildExecutionState` callback to CAP-019
// `maybeAdvanceAutoReroute` (DI cycle break — see auto-reroute.ts
// docstring).

// CAP-088 (`summarizeToolEvidence` + `looksLikeToolRuntimeEvidence`)
// lives in `agent-runtime/middleware/judges.ts` since FEATURE_100 P2
// (shared with CAP-017 / CAP-018). Imported above for the post-tool
// judge call site.

// `getGitRoot` (CAP-011 helper) lives in
// `agent-runtime/middleware/session-snapshot.ts` since FEATURE_100 P2.
// It was a single-caller helper for `saveSessionSnapshot`.

// 导出 Client 类
// FEATURE_093 (v0.7.24): KodaXClient re-export removed from agent.ts to
// break the agent ↔ client cycle. Barrel `index.ts` imports KodaXClient
// directly from './client.js'.
