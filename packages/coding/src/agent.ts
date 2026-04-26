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
} from './types.js';
import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';
import { createCostTracker, recordUsage, getSummary, formatCostReport, type CostTracker } from '@kodax/ai';
import path from 'path';
// FEATURE_093 (v0.7.24): `KodaXClient` is only re-exported from this module
// for backward compatibility. Importing it here creates a cycle
// (agent ↔ client, since client imports `runKodaX` from this file). The
// public barrel `index.ts` re-exports `KodaXClient` directly from
// `./client.js` instead — see line ~592.
import { resolveProvider } from './providers/index.js';
import {
  getRequiredToolParams,
  listToolDefinitions,
} from './tools/index.js';
import {
  mergeManagedProtocolPayload,
  getManagedBlockNameForRole,
  hasManagedProtocolForRole,
  textContainsManagedBlock,
  MANAGED_PROTOCOL_TOOL_NAME,
} from './managed-protocol.js';
import { generateSessionId, extractTitleFromMessages } from './session.js';
import { checkIncompleteToolCalls } from './messages.js';
// FEATURE_076 Q4: load-time normalization for pre-v0.7.25 session messages.
import { normalizeLoadedSessionMessages } from './task-engine/_internal/round-boundary.js';
import { compact as intelligentCompact, needsCompaction, microcompact, DEFAULT_MICROCOMPACTION_CONFIG, buildPostCompactAttachments, buildFileContentMessages, injectPostCompactAttachments, DEFAULT_POST_COMPACT_CONFIG, POST_COMPACT_TOKEN_BUDGET, type CompactionConfig, type CompactionUpdate } from '@kodax/agent';
import { loadCompactionConfig } from './compaction-config.js';
import { estimateTokens } from './tokenizer.js';
import { KODAX_MAX_INCOMPLETE_RETRIES, KODAX_MAX_MAXTOKENS_RETRIES, CANCELLED_TOOL_RESULT_MESSAGE } from './constants.js';
import { waitForRetryDelay } from './retry-handler.js';
import {
  resolveResilienceConfig,
  classifyResilienceError,
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from './resilience/index.js';
import { buildPromptMessageContent } from './input-artifacts.js';
import {
  appendPromptIfNotDuplicate,
  resolveInitialMessages,
} from './agent-runtime/middleware/auto-resume.js';
import {
  createReasoningPlan,
  reasoningModeToDepth,
  type ReasoningPlan,
} from './reasoning.js';
import {
  buildProviderPolicyPromptNotes,
  evaluateProviderPolicy,
} from './provider-policy.js';
import { resolveExecutionCwd, resolveExecutionPath } from './runtime-paths.js';
import {
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
} from './repo-intelligence/runtime.js';
import {
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  createEstimatedContextTokenSnapshot,
  rebaseContextTokenSnapshot,
  resolveContextTokenCount,
} from './token-accounting.js';
import { applyToolResultGuardrail } from './tools/tool-result-policy.js';
import {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './agent-runtime/history-cleanup.js';
// CAP-010 (`getToolExecutionOverride`) was used inline before CAP-024;
// since CAP-024 moved into `agent-runtime/tool-dispatch.ts`, this
// agent.ts no longer imports it directly.
import {
  estimateProviderPayloadBytes,
  bucketProviderPayloadSize,
} from './agent-runtime/provider-payload.js';
import { checkPromiseSignal } from './agent-runtime/thinking-mode-replay.js';
import { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
import { isVisibleToolName, hasQueuedFollowUp } from './agent-runtime/event-emitter.js';
import { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
import {
  isCancelledToolResultContent,
  isToolResultErrorContent,
} from './agent-runtime/tool-result-classify.js';
import {
  filterExcludedTools,
  getActiveToolDefinitions,
  getRuntimeActiveToolNames,
} from './agent-runtime/tool-resolution.js';
import { gracefulCompactDegradation } from './agent-runtime/compaction-fallback.js';
import { updateToolOutcomeTracking } from './agent-runtime/middleware/tool-outcome-tracking.js';
import {
  type ProviderPrepareState,
  applyProviderPrepareHook,
} from './agent-runtime/provider-hook.js';
import {
  createToolResultBlock,
  executeToolCall,
} from './agent-runtime/tool-dispatch.js';
import { buildReasoningExecutionState } from './agent-runtime/reasoning-plan-entry.js';
import { resolveContextWindow } from './agent-runtime/context-window.js';
import {
  type RuntimeSessionState,
  buildRuntimeSessionState,
} from './agent-runtime/runtime-session-state.js';
import { saveSessionSnapshot } from './agent-runtime/middleware/session-snapshot.js';
import { emitRepoIntelligenceTrace } from './agent-runtime/middleware/repo-intelligence.js';
export { buildAutoRepoIntelligenceContext } from './agent-runtime/middleware/repo-intelligence.js';
import {
  type RunnableToolCall,
  buildEditRecoveryUserMessage,
} from './agent-runtime/middleware/edit-recovery.js';
import {
  buildMutationScopeReflection,
  isMutationScopeSignificant,
  isMutationTool,
} from './agent-runtime/middleware/mutation-reflection.js';
import {
  hasStrongToolFailureEvidence,
  isReviewFinalAnswerCandidate,
  summarizeToolEvidence,
} from './agent-runtime/middleware/judges.js';
import { maybeAdvanceAutoReroute } from './agent-runtime/middleware/auto-reroute.js';
import {
  appendQueuedRuntimeMessages,
  createExtensionRuntimeSessionController,
  settleExtensionTurn,
} from './agent-runtime/middleware/extension-queue.js';
export { estimateProviderPayloadBytes, bucketProviderPayloadSize } from './agent-runtime/provider-payload.js';
export { checkPromiseSignal } from './agent-runtime/thinking-mode-replay.js';
export { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
export { saveSessionSnapshot } from './agent-runtime/middleware/session-snapshot.js';
export { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
import {
  emitActiveExtensionEvent,
  getActiveExtensionRuntime,
  setActiveExtensionRuntime,
  KodaXExtensionRuntime,
} from './extensions/runtime.js';

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
// Re-exported above so external callers (scout-signals.ts, ../index.js)
// keep working without an import-path churn.

// CAP-038 (`hasQueuedFollowUp`) lives in
// `agent-runtime/event-emitter.ts` since FEATURE_100 P2.
// CAP-037 (`isToolResultErrorContent`, `isCancelledToolResultContent`)
// lives in `agent-runtime/tool-result-classify.ts` since FEATURE_100 P2.

// CAP-016 (`MUTATION_TOOL_NAMES`, `isMutationTool`,
// `isMutationScopeSignificant`, `buildMutationScopeReflection`) lives in
// `agent-runtime/middleware/mutation-reflection.ts` since FEATURE_100 P2.
// Imported above for the post-tool-result loop call site.

// CAP-010 (`getToolExecutionOverride`) lives in
// `agent-runtime/permission-gate.ts` since FEATURE_100 P2.

// CAP-011 + CAP-013 (`saveSessionSnapshot`) live in
// `agent-runtime/middleware/session-snapshot.ts` since FEATURE_100 P2.
// The function is imported above for the four in-file calling sites
// and re-exported (line 130) so `runner-driven.ts:70` keeps working.

// `createToolResultBlock` (helper, no own CAP) lives in
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2 (CAP-024 batch).
// Imported above for the dispatch loop's 4 result-block construction
// sites (success / cancel / blocked / generic error paths).

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
// All four are imported above for use in the dispatch loop and
// `updateToolOutcomeTracking`.

// CAP-026 (`updateToolOutcomeTracking`) lives in
// `agent-runtime/middleware/tool-outcome-tracking.ts` since FEATURE_100 P2.
// Imported above for the post-tool-result hook in the dispatch loop.
// Will likely co-locate with CAP-024 (`tool-dispatch.ts`) in P3 per
// inventory's "shared with CAP-024" annotation.

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
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2.
// Imported above for the dispatch loop's per-`tool_use` execution
// step inside `runKodaX`.

// CAP-025 (`tryMcpFallback`, `MCP_FALLBACK_ALLOWED_TOOLS`) lives in
// `agent-runtime/tool-dispatch.ts` since FEATURE_100 P2. `tryMcpFallback`
// is imported above for the dispatch loop's MCP-fallback branch
// inside `executeToolCall`. P3 plan: CAP-024 (`executeToolCall`) will
// co-locate into the same module.

/**
 * 运行 KodaX Agent
 * 核心入口函数 - 极简 API
 */
export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const previousActiveRuntime = getActiveExtensionRuntime();
  // FEATURE_093 (v0.7.24): `options.extensionRuntime` is typed as the narrow
  // `ExtensionRuntimeContract` in `types.ts` to break the types↔runtime
  // cycle, but agent internals consume the full class surface. Cast here at
  // the single entry point rather than at every call site.
  const runtime = (options.extensionRuntime as KodaXExtensionRuntime | undefined) ?? previousActiveRuntime;
  if (runtime && runtime !== previousActiveRuntime) {
    setActiveExtensionRuntime(runtime);
  }
  let releaseRuntimeBinding: (() => void) | undefined;
  try {
  const maxIter = options.maxIter ?? 200;
  const events = options.events ?? {};
  const runtimeDefaults = runtime?.getDefaults();
  let currentProviderName = runtimeDefaults?.modelSelection.provider ?? options.provider;
  let currentModelOverride = runtimeDefaults?.modelSelection.model ?? options.modelOverride ?? options.model;
  let runtimeThinkingLevel = runtimeDefaults?.thinkingLevel;

  // Load compaction config
  const compactionConfig = await loadCompactionConfig(options.context?.gitRoot ?? undefined);
  const initialProvider = resolveProvider(currentProviderName);
  if (!initialProvider.isConfigured()) {
    throw new Error(
      `Provider "${currentProviderName}" not configured. Set ${initialProvider.getApiKeyEnv()}`,
    );
  }

  // 处理 autoResume/resume：自动加载当前目录最近会话
  let resolvedSessionId = options.session?.id;
  if ((options.session?.autoResume || options.session?.resume) && options.session?.storage && !resolvedSessionId) {
    const storage = options.session.storage;
    if (storage.list) {
      const sessions = await storage.list();
      if (sessions.length > 0) {
        resolvedSessionId = sessions[0]!.id;  // 最近会话
      }
    }
  }

  const sessionId = resolvedSessionId ?? await generateSessionId();

  // CAP-008: resolve transcript from initialMessages → storage.load → empty;
  // CAP-046: append current prompt unless transcript tail is already the
  // same canonical text. Both helpers live in
  // `agent-runtime/middleware/auto-resume.ts` since FEATURE_100 P2.
  const resumed = await resolveInitialMessages(options, sessionId);
  let messages = appendPromptIfNotDuplicate(
    resumed.messages,
    prompt,
    options.context?.inputArtifacts,
  );
  let title = resumed.title || (prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''));
  const errorMetadata: SessionErrorMetadata | undefined = resumed.errorMetadata;
  const loadedExtensionState: KodaXExtensionSessionState | undefined = resumed.loadedExtensionState;
  const loadedExtensionRecords: KodaXExtensionSessionRecord[] | undefined = resumed.loadedExtensionRecords;

  const executionCwd = resolveExecutionCwd(options.context);
  let emittedManagedProtocolPayload = options.context?.managedProtocolEmission?.enabled
    ? mergeManagedProtocolPayload(undefined, undefined)
    : undefined;

  // Simplified context - no permission fields (handled by REPL layer)
  const ctx: KodaXToolExecutionContext = {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    executionCwd,
    extensionRuntime: runtime ?? undefined,
    askUser: events.askUser, // Issue 069: Pass askUser callback from events
    askUserInput: events.askUserInput, // Issue 112: Pass askUserInput callback from events
    // FEATURE_074: only forward the new exit_plan_mode callback.
    // set_permission_mode is NOT forwarded — it was broken before this feature
    // (callback never wired), and a corpus of sessions shows LLMs occasionally
    // call it in auto-in-project too, not just plan mode. Activating it now would
    // silently widen permissions (auto-in-project's path scope → accept-edits's
    // no-scope) on any misfire. Keep it failing until removal in v0.7.21+.
    exitPlanMode: events.exitPlanMode,
    abortSignal: options.abortSignal, // Issue 113: Pass abort signal to tool handlers
    managedProtocolRole: options.context?.managedProtocolEmission?.enabled
      ? options.context.managedProtocolEmission.role
      : undefined,
    emitManagedProtocol: options.context?.managedProtocolEmission?.enabled
      ? (payload: Partial<KodaXManagedProtocolPayload>) => {
          emittedManagedProtocolPayload = mergeManagedProtocolPayload(
            emittedManagedProtocolPayload,
            payload,
          );
        }
      : undefined,
    registerChildWriteWorktrees: options.context?.registerChildWriteWorktrees,
    mutationTracker: options.context?.mutationTracker,
    // FEATURE_074: forward parent's plan-mode predicate so dispatch_child_task
    // can enforce plan mode on child tool calls using live parent state.
    planModeBlockCheck: options.context?.planModeBlockCheck,
    parentAgentConfig: {
      provider: options.provider,
      model: options.model,
      reasoningMode: options.reasoningMode,
    },
    // FEATURE_067: onChildProgress removed — it fired onManagedTaskStatus with
    // activeWorkerId='child', which triggered a foreground worker transition in the
    // REPL and cleared all live tool calls. Progress is now handled entirely via
    // reportToolProgress → onToolProgress, which updates both the tool block and spinner.
    onChildProgress: undefined,
  };
  const finalizeManagedProtocolResult = (result: KodaXResult): KodaXResult => {
    const payload = mergeManagedProtocolPayload(
      result.managedProtocolPayload,
      emittedManagedProtocolPayload,
    );
    return payload
      ? {
          ...result,
          managedProtocolPayload: payload,
        }
      : result;
  };
  let contextTokenSnapshot = rebaseContextTokenSnapshot(
    messages,
    options.context?.contextTokenSnapshot,
  );
  const runtimeSessionState = buildRuntimeSessionState({
    loadedExtensionState,
    loadedExtensionRecords,
    activeTools: filterExcludedTools(
      runtimeDefaults?.activeTools ?? listToolDefinitions().map((tool) => tool.name),
      options.context?.excludeTools,
    ),
    modelSelection: {
      provider: currentProviderName,
      model: currentModelOverride,
    },
    thinkingLevel: runtimeThinkingLevel,
  });
  releaseRuntimeBinding = runtime?.bindController(
    createExtensionRuntimeSessionController(runtimeSessionState),
  );

  await runtime?.hydrateSession(sessionId);

  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      autoRepoMode !== 'off' && (options.context?.executionCwd || options.context?.gitRoot)
        ? await getRepoRoutingSignals({
          executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: autoRepoMode,
        }).catch(() => null)
        : null
    );
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
    provider: currentProviderName,
    modelOverride: currentModelOverride,
  }, prompt, initialProvider, {
    recentMessages: messages.slice(0, -1),
    sessionErrorMetadata: errorMetadata,
    repoSignals: repoRoutingSignals ?? undefined,
  });
  let currentExecution = await buildReasoningExecutionState(
    {
      ...options,
      provider: currentProviderName,
      modelOverride: currentModelOverride,
      reasoningMode: runtimeThinkingLevel ?? options.reasoningMode,
    },
    runtimeThinkingLevel
      ? {
        ...reasoningPlan,
        mode: runtimeThinkingLevel,
        depth: reasoningModeToDepth(runtimeThinkingLevel),
      }
      : reasoningPlan,
    messages.length === 1,
  );
  let autoFollowUpCount = 0;
  let autoDepthEscalationCount = 0;
  let autoTaskRerouteCount = 0;
  const autoFollowUpLimit = 2;
  let preAnswerJudgeConsumed = false;
  let postToolJudgeConsumed = false;

  let lastText = '';
  let incompleteRetryCount = 0;
  let maxTokensRetryCount = 0;
  let limitReached = false; // Track if we exited due to iteration limit - 追踪是否因达到迭代上限而退出
  const emitIterationEnd = (
    iterNumber: number,
    snapshotOverride?: typeof contextTokenSnapshot,
  ): typeof contextTokenSnapshot => {
    contextTokenSnapshot = rebaseContextTokenSnapshot(
      messages,
      snapshotOverride ?? contextTokenSnapshot,
    );
    events.onIterationEnd?.({
      iter: iterNumber,
      maxIter,
      tokenCount: contextTokenSnapshot.currentTokens,
      tokenSource: contextTokenSnapshot.source,
      usage: contextTokenSnapshot.usage,
      contextTokenSnapshot,
    });
    return contextTokenSnapshot;
  };
  const currentRoutingDecision = () => reasoningPlan.decision;
    events.onSessionStart?.({ provider: initialProvider.name, sessionId });
    await emitActiveExtensionEvent('session:start', { provider: initialProvider.name, sessionId });

    // Cost tracking — lightweight session-scoped tracker
    let costTracker: CostTracker = createCostTracker();
    if (events.getCostReport) {
      events.getCostReport.current = () => formatCostReport(getSummary(costTracker));
    }

    let managedProtocolContinueAttempted = false;
    let compactConsecutiveFailures = 0;
    const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;
    for (let iter = 0; iter < maxIter; iter++) {
    try {
      currentProviderName = runtimeSessionState.modelSelection.provider ?? options.provider;
      currentModelOverride = runtimeSessionState.modelSelection.model ?? options.modelOverride ?? options.model;
      runtimeThinkingLevel = runtimeSessionState.thinkingLevel;
      const provider = resolveProvider(currentProviderName);
      if (!provider.isConfigured()) {
        throw new Error(
          `Provider "${currentProviderName}" not configured. Set ${provider.getApiKeyEnv()}`,
        );
      }
      const contextWindow = resolveContextWindow(compactionConfig, provider, currentModelOverride);
      const effectiveReasoningPlan = runtimeThinkingLevel
        ? {
          ...reasoningPlan,
          mode: runtimeThinkingLevel,
          depth: reasoningModeToDepth(runtimeThinkingLevel),
        }
        : reasoningPlan;
      currentExecution = await buildReasoningExecutionState(
        {
          ...options,
          provider: currentProviderName,
          modelOverride: currentModelOverride,
          reasoningMode: runtimeThinkingLevel ?? options.reasoningMode,
        },
        effectiveReasoningPlan,
        messages.length === 1,
      );

      await emitActiveExtensionEvent('turn:start', {
        sessionId,
        iteration: iter + 1,
        maxIter,
      });
      events.onIterationStart?.(iter + 1, maxIter);

      // Microcompaction: lightweight cleanup each turn (no LLM calls)
      // Clears old tool results, thinking blocks, and image blocks
      messages = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG) as KodaXMessage[];

      // Compaction: 统一使用智能压缩，废除遗留的粗暴截断
      let compacted: KodaXMessage[];
      let didCompactMessages = false;
      let compactionUpdate: CompactionUpdate | undefined;

      // 判断是否需要压缩：只依据智能压缩阈值 (默认 75%)
      const currentTokens = resolveContextTokenCount(messages, contextTokenSnapshot);
      const needsCompact =
        compactionConfig.enabled
        && needsCompaction(messages, compactionConfig, contextWindow, currentTokens);

      // Circuit breaker: only disables LLM-based summarization, NOT the fallback
      const circuitBreakerTripped = compactConsecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT;

      if (needsCompact && !circuitBreakerTripped) {
        // LLM-based intelligent compaction path
        events.onCompactStart?.();
        try {
          const result = await intelligentCompact(
            messages,
            compactionConfig,
            provider,
            contextWindow,
            undefined, // customInstructions
            currentExecution.systemPrompt,
            currentTokens,
          );

          if (result.compacted) {
            compacted = result.messages;

            // Post-compact reconstruction: inject artifact ledger summary + file content
            // FEATURE_072: `postCompactAttachmentsForLineage` captures the flat
            // attachment messages so they can also be routed via
            // `compactionUpdate.postCompactAttachments` for REPL-side native
            // storage on the CompactionEntry. Agent.ts still inlines them into
            // local `messages` for consumers that continue to read flat messages.
            let postCompactAttachmentsForLineage: readonly KodaXMessage[] = [];
            if (result.artifactLedger && result.artifactLedger.length > 0) {
              const freedTokens = result.tokensBefore - result.tokensAfter;
              const attachments = buildPostCompactAttachments(
                result.artifactLedger,
                freedTokens,
              );

              // Read recently modified files and inject content (async I/O)
              // Budget = total post-compact budget minus ledger tokens, capped by absolute budget.
              // Aligns with Claude Code's POST_COMPACT_TOKEN_BUDGET (fixed cap, not proportional).
              const totalPostCompactBudget = Math.min(
                Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
                POST_COMPACT_TOKEN_BUDGET,
              );
              const fileBudget = Math.max(0, totalPostCompactBudget - attachments.totalTokens);
              const fileMessages = fileBudget > 0
                ? await buildFileContentMessages(result.artifactLedger, fileBudget)
                : [];

              const fullAttachments = {
                ...attachments,
                fileMessages,
                totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
              };

              if (fullAttachments.totalTokens > 0) {
                compacted = injectPostCompactAttachments(compacted, fullAttachments);
                // Flat list for compactionUpdate: preserves [ledgerMessage, ...fileMessages] order
                postCompactAttachmentsForLineage = [
                  ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
                  ...fullAttachments.fileMessages,
                ];
              }
            }

            didCompactMessages = true;
            // Only reset the circuit-breaker counter when compaction actually
            // reduced context below trigger. "Partial success" (pruning only,
            // with silent summary failure) would otherwise keep the counter
            // at zero forever and prevent graceful degradation from ever running.
            const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
            const postCompactTokens = estimateTokens(compacted);
            if (postCompactTokens < triggerTokens) {
              compactConsecutiveFailures = 0;
            } else {
              compactConsecutiveFailures++;
              console.warn(`[Compaction] Partial success: still above trigger (${postCompactTokens} > ${Math.floor(triggerTokens)}) — attempt ${compactConsecutiveFailures}/${COMPACT_CIRCUIT_BREAKER_LIMIT}`);
            }
            compactionUpdate = {
              anchor: result.anchor,
              artifactLedger: result.artifactLedger,
              memorySeed: result.memorySeed,
              postCompactAttachments: postCompactAttachmentsForLineage.length > 0
                ? postCompactAttachmentsForLineage
                : undefined,
            };
            events.onCompactStats?.({
              tokensBefore: result.tokensBefore,
              tokensAfter: postCompactTokens,
            });
            events.onCompact?.(result.tokensBefore);
          } else {
            compacted = result.messages;
          }
        } catch (error) {
          compactConsecutiveFailures++;
          console.error(`[Compaction Error] LLM summary failed (attempt ${compactConsecutiveFailures}/${COMPACT_CIRCUIT_BREAKER_LIMIT}):`, error);

          // Fall through to graceful degradation below
          compacted = messages;
        } finally {
          events.onCompactEnd?.();
        }
      } else {
        compacted = messages;
      }

      // Graceful degradation: runs when:
      //   - LLM compact threw (compacted === messages because catch set it)
      //   - Circuit breaker tripped (needsCompact && circuitBreakerTripped → else branch)
      //   - LLM compact "partial success" left context still above trigger (new ref, tokens still high)
      // Gating by remaining tokens instead of reference equality catches the third case,
      // which is the root cause of monotonic context growth observed in 0.7.18+.
      //
      // Pass `compacted` (not `messages`) so we keep any pruning work done by
      // intelligentCompact and let graceful do additional atomic-block removal
      // on top, rather than discarding the pruning and starting over.
      if (needsCompact) {
        const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
        const gapRatio = compactionConfig.pruningGapRatio ?? 0.8;
        const stillOverTrigger = estimateTokens(compacted) > triggerTokens * gapRatio;
        if (stillOverTrigger) {
          const degraded = gracefulCompactDegradation(compacted, contextWindow, compactionConfig);
          if (degraded !== compacted) {
            compacted = degraded;
            didCompactMessages = true;
            events.onCompactStats?.({
              tokensBefore: currentTokens,
              tokensAfter: estimateTokens(compacted),
            });
            events.onCompact?.(estimateTokens(compacted));
          }
        }
      }

      // CRITICAL FIX: Always validate and fix tool history before sending to API
      // This prevents "tool_call_id is not found" errors caused by corrupted history
      compacted = validateAndFixToolHistory(compacted);

      // CRITICAL FIX: Update the global session messages to the compacted version!
      // This permanently applies the summary/truncation and prevents the session history from growing infinitely.
      messages = compacted;
      if (didCompactMessages) {
        contextTokenSnapshot = createEstimatedContextTokenSnapshot(messages);
        events.onCompactedMessages?.(messages, compactionUpdate);
      }

      const preparedProviderState = await applyProviderPrepareHook({
        provider: currentProviderName,
        model: currentModelOverride,
        reasoningMode: effectiveReasoningPlan.mode,
        systemPrompt: currentExecution.systemPrompt,
      });
      if (preparedProviderState.blockedReason) {
        throw new Error(preparedProviderState.blockedReason);
      }
      currentProviderName = preparedProviderState.provider;
      currentModelOverride = preparedProviderState.model;
      runtimeSessionState.modelSelection.provider = currentProviderName;
      runtimeSessionState.modelSelection.model = currentModelOverride;
      runtimeThinkingLevel = preparedProviderState.reasoningMode;
      runtimeSessionState.thinkingLevel = runtimeThinkingLevel;
      const effectiveProviderReasoningMode = runtimeThinkingLevel ?? effectiveReasoningPlan.mode;
      const effectiveProviderReasoning = {
        ...currentExecution.providerReasoning,
        enabled: effectiveProviderReasoningMode !== 'off',
        mode: effectiveProviderReasoningMode,
        depth: reasoningModeToDepth(effectiveProviderReasoningMode),
      };

      const streamProvider = resolveProvider(currentProviderName);
      const providerPolicy = evaluateProviderPolicy({
        providerName: currentProviderName,
        model: currentModelOverride,
        provider: streamProvider,
        prompt,
        options: currentExecution.effectiveOptions,
        context: currentExecution.effectiveOptions.context,
        reasoningMode: effectiveProviderReasoningMode,
        taskType: effectiveReasoningPlan.decision.primaryTask,
        executionMode: effectiveReasoningPlan.decision.recommendedMode,
      });
      if (providerPolicy.status === 'block') {
        throw new Error(`[Provider Policy] ${providerPolicy.summary}`);
      }
      const effectiveSystemPrompt = providerPolicy.issues.length > 0
        ? [
          preparedProviderState.systemPrompt,
          buildProviderPolicyPromptNotes(providerPolicy).join('\n'),
        ].join('\n\n')
        : preparedProviderState.systemPrompt;
      if (!streamProvider.isConfigured()) {
        throw new Error(
          `Provider "${currentProviderName}" not configured. Set ${streamProvider.getApiKeyEnv()}`,
        );
      }

      await emitActiveExtensionEvent('provider:selected', {
        provider: currentProviderName,
        model: currentModelOverride,
      });

      // 流式调用 Provider - with automatic retry for transient errors
      // 注入 API 硬超时保护：防止大型 payload 导致 API 静默丢包引发无限等待
      // Feature 045: resilience config replaces hardcoded timeouts
      const resilienceCfg = resolveResilienceConfig(currentProviderName);
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs; // Issue 084: 提升到 10 分钟硬超时
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;  // Issue 084: 60 秒空闲/停滞超时，如果有 delta 刷新则重置
      let providerMessages = compacted;
      let result!: KodaXStreamResult;
      let attempt = 0;
      const boundaryTracker = new StableBoundaryTracker();
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback:
          resilienceCfg.enableNonStreamingFallback && streamProvider.supportsNonStreamingFallback(),
      });
      const activeToolDefinitions = getActiveToolDefinitions(
        runtimeSessionState.activeTools,
        options.context?.repoIntelligenceMode,
        options.context?.managedProtocolEmission?.enabled === true,
        !!runtime,
        options.context?.toolConstructionMode,
      );

      while (true) {
        attempt += 1;
        boundaryTracker.beginRequest(
          currentProviderName,
          currentModelOverride ?? streamProvider.getModel(),
          providerMessages,
          attempt,
          false,
        );
        telemetryBoundary(boundaryTracker.snapshot());

        const retryTimeoutController = new AbortController();
        let hardTimer = setTimeout(() => {
          retryTimeoutController.abort(new Error("API Hard Timeout (10 minutes)"));
        }, API_HARD_TIMEOUT_MS);

        // Stream max-duration watchdog: per-provider hard cap on a single
        // streaming request's wall-clock duration. Set just below a known
        // server-side kill window to abort BEFORE the server RSTs, routing
        // through the existing non_streaming_fallback path with a clean
        // StreamIncompleteError instead of a mid-stream socket reset.
        // Distinct from the idle timer: kill windows are duration-based and
        // some providers (e.g. zhipu-coding) emit keepalive pings during
        // long tool_use generation, so an idle timer never fires.
        const STREAM_MAX_DURATION_MS = streamProvider.getStreamMaxDurationMs?.() ?? 0;
        let streamMaxDurationTimer: ReturnType<typeof setTimeout> | undefined;
        if (STREAM_MAX_DURATION_MS > 0) {
          streamMaxDurationTimer = setTimeout(() => {
            retryTimeoutController.abort(
              new Error(`Stream max duration exceeded (${STREAM_MAX_DURATION_MS}ms; provider has known server-side kill window)`),
            );
          }, STREAM_MAX_DURATION_MS);
        }

        // Stream idle timer: disabled by default (API_IDLE_TIMEOUT_MS === 0).
        // When enabled, aborts the stream if no content events arrive within
        // the timeout window.  The hard timeout above is always active.
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`));
          }, API_IDLE_TIMEOUT_MS);
        }

        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`));
            }, API_IDLE_TIMEOUT_MS);
          }
        };

        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, effectiveSystemPrompt);
        emitResilienceDebug('[resilience:request]', {
          provider: currentProviderName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
          lastToolErrorCode: runtimeSessionState.lastToolErrorCode,
          lastToolResultBytes: runtimeSessionState.lastToolResultBytes,
        });

        try {
          result = await streamProvider.stream(
            providerMessages,
            activeToolDefinitions,
            effectiveSystemPrompt,
            effectiveProviderReasoning,
            {
              onTextDelta: (text) => {
                resetIdleTimer();
                boundaryTracker.markTextDelta(text);
                void emitActiveExtensionEvent('text:delta', { text });
                events.onTextDelta?.(text);
              },
              onThinkingDelta: (text) => {
                resetIdleTimer();
                boundaryTracker.markThinkingDelta(text);
                void emitActiveExtensionEvent('thinking:delta', { text });
                events.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking) => {
                resetIdleTimer();
                void emitActiveExtensionEvent('thinking:end', { thinking });
                events.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: (name, json, meta) => {
                resetIdleTimer();
                boundaryTracker.markToolInputStart(meta?.toolId ?? `pending:${name}`);
                events.onToolInputDelta?.(name, json, meta);
              },
              onRateLimit: (rateAttempt, max, delay) => {
                resetIdleTimer();
                void emitActiveExtensionEvent('provider:rate-limit', {
                  provider: currentProviderName,
                  attempt: rateAttempt,
                  maxRetries: max,
                  delayMs: delay,
                });
                events.onProviderRateLimit?.(rateAttempt, max, delay);
              },
              onHeartbeat: (pause) => {
                if (pause) {
                  // Between content blocks: server may be silent while generating
                  // the next block.  Clear idle timer but do NOT restart it — the
                  // hard request timeout (10 min) still guards against stuck connections.
                  clearTimeout(idleTimer);
                } else {
                  resetIdleTimer();
                }
              },
              modelOverride: currentModelOverride,
              signal: retrySignal,
            },
            retrySignal,
          );

          messages = providerMessages;
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (error.name === 'AbortError' && retryTimeoutController.signal.aborted && !options.abortSignal?.aborted) {
            const reason = retryTimeoutController.signal.reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax/ai');
            error = new KodaXNetworkError(reason, true);
          }

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          events.onProviderRecovery?.({
            stage: decision.failureStage,
            errorClass: decision.reasonCode,
            attempt,
            maxAttempts: resilienceCfg.maxRetries,
            delayMs: decision.delayMs,
            recoveryAction: decision.action,
            ladderStep: decision.ladderStep,
            fallbackUsed: decision.shouldUseNonStreaming,
            serverRetryAfterMs: decision.serverRetryAfterMs,
          });

          if (!events.onProviderRecovery && decision.action !== 'manual_continue') {
            events.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming) {
            const fallbackBytes = estimateProviderPayloadBytes(providerMessages, effectiveSystemPrompt);
            emitResilienceDebug('[resilience:fallback]', {
              provider: currentProviderName,
              attempt,
              payloadBytes: fallbackBytes,
              payloadBucket: bucketProviderPayloadSize(fallbackBytes),
            });

            try {
              const fallbackTimeoutController = new AbortController();
              const fallbackSignal = options.abortSignal
                ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
                : fallbackTimeoutController.signal;
              const fallbackHardTimer = setTimeout(() => {
                fallbackTimeoutController.abort(new Error("API Hard Timeout (10 minutes)"));
              }, API_HARD_TIMEOUT_MS);
              try {
                clearTimeout(idleTimer);
                clearTimeout(hardTimer);
                clearTimeout(streamMaxDurationTimer);
                boundaryTracker.beginRequest(
                  currentProviderName,
                  currentModelOverride ?? streamProvider.getModel(),
                  providerMessages,
                  attempt,
                  true,
                );
                telemetryBoundary(boundaryTracker.snapshot());
                result = await streamProvider.complete(
                  providerMessages,
                  activeToolDefinitions,
                  effectiveSystemPrompt,
                  effectiveProviderReasoning,
                  {
                    onTextDelta: (text) => {
                      boundaryTracker.markTextDelta(text);
                      void emitActiveExtensionEvent('text:delta', { text });
                      events.onTextDelta?.(text);
                    },
                    onThinkingDelta: (text) => {
                      boundaryTracker.markThinkingDelta(text);
                      void emitActiveExtensionEvent('thinking:delta', { text });
                      events.onThinkingDelta?.(text);
                    },
                    onThinkingEnd: (thinking) => {
                      void emitActiveExtensionEvent('thinking:end', { thinking });
                      events.onThinkingEnd?.(thinking);
                    },
                    modelOverride: currentModelOverride,
                    signal: fallbackSignal,
                  },
                  fallbackSignal,
                );
                messages = providerMessages;
                break;
              } finally {
                clearTimeout(fallbackHardTimer);
              }
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            }
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) gated by
          // its own latch inside the coordinator. Bypass the maxRetries
          // gate so it can fire even when normal retries are exhausted.
          // Mirrors the runner-driven path at runner-driven.ts:2654.
          //
          // The mirror is intentional, not migration debt: this file is
          // the SA-mode entry (`runDirectKodaX`) and runner-driven.ts is
          // the AMA-mode path (Scout/Planner/Generator/Evaluator). They
          // are two parallel execution modes (see task-engine.ts:11-13
          // dispatch) with no convergence plan, but they share the same
          // provider stack and therefore see the same thinking-mode
          // errors. Per CLAUDE.md "abstract only after 3+ real cases",
          // 2 call sites stay duplicated. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            clearTimeout(hardTimer);
            clearTimeout(idleTimer);
            clearTimeout(streamMaxDurationTimer);
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

          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
          clearTimeout(streamMaxDurationTimer);
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
          clearTimeout(streamMaxDurationTimer);
        }
      }

      // 流式输出结束，通知 CLI 层
      events.onStreamEnd?.();
      await emitActiveExtensionEvent('stream:end', undefined);

      // Record cost for this LLM call
      if (result.usage) {
        costTracker = recordUsage(costTracker, {
          provider: currentProviderName,
          model: currentModelOverride ?? 'unknown',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        });
      }

      lastText = result.textBlocks.map(b => b.text).join(' ');
      const preAssistantTokenSnapshot = createContextTokenSnapshot(compacted, result.usage);
      const visibleToolBlocks = result.toolBlocks.filter((block) => isVisibleToolName(block.name));

      // Promise 信号检测
      const [signal, _reason] = checkPromiseSignal(lastText);
      if (signal) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
          signal: signal as 'COMPLETE' | 'BLOCKED' | 'DECIDE',
        });
        const appendedQueuedMessages = appendQueuedRuntimeMessages(messages, runtimeSessionState);
        if (appendedQueuedMessages) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: signal as 'COMPLETE' | 'BLOCKED' | 'DECIDE',
          });
          continue;
        }
        if (signal === 'COMPLETE') {
          emitIterationEnd(iter + 1, preAssistantTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: 'COMPLETE',
          });
          events.onComplete?.();
          await emitActiveExtensionEvent('complete', { success: true, signal: 'COMPLETE' });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
            signal: 'COMPLETE',
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
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

      let assistantContent = [...result.thinkingBlocks, ...result.textBlocks, ...visibleToolBlocks];
      // Guard: never push an assistant message with empty content.
      // This can happen when the model only emits invisible tool calls (e.g. emit_managed_protocol)
      // with no text or thinking. Providers like Kimi reject empty content (400 error).
      if (assistantContent.length === 0) {
        assistantContent = [{ type: 'text' as const, text: '...' }];
      }
      messages.push({ role: 'assistant', content: assistantContent });
      const completedTurnTokenSnapshot = createCompletedTurnTokenSnapshot(messages, result.usage);
      contextTokenSnapshot = completedTurnTokenSnapshot;

      // L5 continuation: max_tokens hit and no tool was emitted (so the
      // model was producing pure text and got cut mid-thought). Inject a
      // Claude-Code-style recovery meta message instructing the model to
      // resume mid-thought and break remaining work into smaller pieces
      // (so a too-large Write becomes Write+Edit across turns). Capped at
      // KODAX_MAX_MAXTOKENS_RETRIES (3) to prevent infinite loops.
      //
      // Skipped when there are completed tool_use blocks — even if those
      // blocks were salvaged from truncated JSON, the agent can execute
      // the partial tool, observe the resulting state via tool_result, and
      // naturally continue with edit/append in the next turn. No explicit
      // meta nudge needed.
      if (result.stopReason === 'max_tokens' && result.toolBlocks.length === 0) {
        maxTokensRetryCount++;
        if (maxTokensRetryCount <= KODAX_MAX_MAXTOKENS_RETRIES) {
          events.onTextDelta?.('\n\n[output token limit hit, continuing…]\n\n');
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
                'Pick up mid-thought if that is where the cut happened. ' +
                'Break remaining work into smaller pieces.',
            }],
            _synthetic: true,
          });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          continue;
        }
        // Retries exhausted — fall through to text-only response handling
        events.onRetry?.(`max_tokens truncation limit reached (${maxTokensRetryCount - 1}/${KODAX_MAX_MAXTOKENS_RETRIES})`, maxTokensRetryCount - 1, KODAX_MAX_MAXTOKENS_RETRIES);
      }

      // Fallback: auto-continue when end_turn fires but required managed protocol block is missing.
      // Skipped when protocol is optional (e.g. Scout with full tools — protocol only needed for escalation).
      if (
        !managedProtocolContinueAttempted
        && result.stopReason === 'end_turn'
        && result.toolBlocks.length === 0
        && lastText
        && options.context?.managedProtocolEmission?.enabled
        && !options.context.managedProtocolEmission.optional
      ) {
        const role = options.context.managedProtocolEmission.role;
        const blockName = getManagedBlockNameForRole(role);
        if (
          blockName
          && !hasManagedProtocolForRole(emittedManagedProtocolPayload, role)
          && !textContainsManagedBlock(lastText, blockName)
        ) {
          managedProtocolContinueAttempted = true;
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text: `Your response is complete but the required protocol was not emitted. Do NOT output any text — ONLY call the "${MANAGED_PROTOCOL_TOOL_NAME}" tool now, or append a \`\`\`${blockName}\`\`\` fenced block. No other output.`,
            }],
            _synthetic: true,
          });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          continue;
        }
      }

      if (result.toolBlocks.length === 0) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
            messages,
            sessionId,
            routingDecision: currentRoutingDecision(),
            contextTokenSnapshot,
            limitReached: false,
          });
        }

        if (
          effectiveReasoningPlan.mode === 'auto' &&
          autoFollowUpCount < autoFollowUpLimit &&
          (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0) &&
          !preAnswerJudgeConsumed &&
          isReviewFinalAnswerCandidate(prompt, effectiveReasoningPlan, lastText)
        ) {
          preAnswerJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: messages.length === 1,
            retryLabelPrefix: 'Auto',
            allowTaskReroute: !options.context?.disableAutoTaskReroute,
            buildExecutionState: buildReasoningExecutionState,
            onApply: () => {
              messages.pop();
            },
          });
          if (rerouteState) {
            ({
              reasoningPlan,
              currentExecution,
              autoFollowUpCount,
              autoDepthEscalationCount,
              autoTaskRerouteCount,
            } = rerouteState);
            contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
            continue;
          }
        }
        emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        // limitReached 保持 false（初始值）
        break;
      }

      // 检测截断 + 自动重试
      const incomplete = checkIncompleteToolCalls(result.toolBlocks);
      if (incomplete.length > 0) {
        incompleteRetryCount++;
        if (incompleteRetryCount <= KODAX_MAX_INCOMPLETE_RETRIES) {
          events.onRetry?.(`Incomplete tool calls: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          messages.pop();
          let retryPrompt: string;
          if (incompleteRetryCount === 1) {
            retryPrompt = `Your previous response was truncated. Missing required parameters:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nPlease provide the complete tool calls with ALL required parameters.\nFor large content, keep it concise (under 50 lines for write operations).`;
          } else {
            retryPrompt = `⚠️ CRITICAL: Your response was TRUNCATED again. This is retry ${incompleteRetryCount}/${KODAX_MAX_INCOMPLETE_RETRIES}.\n\nMISSING PARAMETERS:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nYOU MUST:\n1. For 'write' tool: Keep content under 50 lines - write structure first, fill in later with 'edit'\n2. For 'edit' tool: Keep new_string under 30 lines - make smaller, focused changes\n3. Provide ALL required parameters in your tool call\n\nIf your response is truncated again, the task will FAIL.\nPROVIDE SHORT, COMPLETE PARAMETERS NOW.`;
          }
          messages.push({ role: 'user', content: retryPrompt, _synthetic: true });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, preAssistantTokenSnapshot);
          continue;
        } else {
          // 超过重试次数，过滤掉不完整的工具调用并添加错误结果
          events.onRetry?.(`Max retries exceeded for incomplete tool calls. Skipping: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          const incompleteIds = new Set<string>();
          for (const tc of result.toolBlocks) {
            const required = getRequiredToolParams(tc.name);
            const input = (tc.input ?? {}) as Record<string, unknown>;
            for (const param of required) {
              if (input[param] === undefined || input[param] === null || input[param] === '') {
                incompleteIds.add(tc.id);
                break;
              }
            }
          }
          // 直接添加错误结果，不执行不完整的工具调用
          const errorResults: KodaXToolResultBlock[] = [];
          for (const id of incompleteIds) {
            const tc = result.toolBlocks.find(t => t.id === id);
            if (tc) {
              const errorMsg = `[Tool Error] ${tc.name}: Skipped due to missing required parameters after ${KODAX_MAX_INCOMPLETE_RETRIES} retries`;
              await emitActiveExtensionEvent('tool:result', {
                id: tc.id,
                name: tc.name,
                content: errorMsg,
              });
              events.onToolResult?.({ id: tc.id, name: tc.name, content: errorMsg });
              errorResults.push(createToolResultBlock(tc.id, errorMsg));
            }
          }
          messages.push({ role: 'user', content: errorResults });
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          incompleteRetryCount = 0;
          continue;
        }
      } else {
        incompleteRetryCount = 0;
      }

      // 执行工具
      const toolResults: KodaXToolResultBlock[] = [];
      const editRecoveryMessages: string[] = [];

      // Issue 088: Check abort signal before entering tool execution phase.
      // Without this guard, tools spawned after Ctrl+C would still run to completion.
      // Use graceful cancellation (mark all tools as cancelled) instead of throwing,
      // so the downstream `hasCancellation` check handles exit uniformly.
      const abortedBeforeTools = options.abortSignal?.aborted === true;

      // Non-bash tools run in parallel; bash tools run sequentially (always parallel mode).
      if (abortedBeforeTools) {
        for (const tc of result.toolBlocks) {
          if (isVisibleToolName(tc.name)) {
            await emitActiveExtensionEvent('tool:result', {
              id: tc.id,
              name: tc.name,
              content: CANCELLED_TOOL_RESULT_MESSAGE,
            });
            events.onToolResult?.({ id: tc.id, name: tc.name, content: CANCELLED_TOOL_RESULT_MESSAGE });
            toolResults.push(createToolResultBlock(tc.id, CANCELLED_TOOL_RESULT_MESSAGE));
          }
        }
      } else {
        const bashTools = result.toolBlocks.filter(tc => tc.name === 'bash');
        const nonBashTools = result.toolBlocks.filter(tc => tc.name !== 'bash');
        const resultMap = new Map<string, string>();

        if (nonBashTools.length > 0) {
          const promises = nonBashTools.map(async tc => ({
            id: tc.id,
            content: (
              await applyToolResultGuardrail(
                tc.name,
                await executeToolCall(events, {
                  id: tc.id,
                  name: tc.name,
                  input: tc.input as Record<string, unknown> | undefined,
                }, ctx, runtimeSessionState, getRuntimeActiveToolNames(
                  runtimeSessionState.activeTools,
                  options.context?.repoIntelligenceMode,
                  !!runtime,
                  options.context?.toolConstructionMode,
                ), options.abortSignal),
                ctx,
              )
            ).content,
          }));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
          // Issue 088: Check abort signal before each sequential bash tool
          if (options.abortSignal?.aborted) {
            resultMap.set(tc.id, CANCELLED_TOOL_RESULT_MESSAGE);
            continue;
          }
          const content = (
            await applyToolResultGuardrail(
              tc.name,
              await executeToolCall(events, {
                id: tc.id,
                name: tc.name,
                input: tc.input as Record<string, unknown> | undefined,
                }, ctx, runtimeSessionState, getRuntimeActiveToolNames(
                  runtimeSessionState.activeTools,
                  options.context?.repoIntelligenceMode,
                  !!runtime,
                  options.context?.toolConstructionMode,
                ), options.abortSignal),
              ctx,
            )
          ).content;
          resultMap.set(tc.id, content);
        }

        for (const tc of result.toolBlocks) {
          let content = resultMap.get(tc.id) ?? '[Error] No result';
          // Scope reflection: when mutation tracker crosses threshold, append once to a write tool result.
          if (
            ctx.mutationTracker
            && !ctx.mutationTracker.reflectionInjected
            && !isToolResultErrorContent(content)
            && isMutationTool(tc.name)
            && isMutationScopeSignificant(ctx.mutationTracker)
          ) {
            content += buildMutationScopeReflection(ctx.mutationTracker);
            ctx.mutationTracker.reflectionInjected = true;
          }
          updateToolOutcomeTracking(tc, content, runtimeSessionState, ctx);
          if (tc.name === 'edit' && isToolResultErrorContent(content)) {
            const recoveryMessage = await buildEditRecoveryUserMessage(tc, content, runtimeSessionState, ctx);
            if (recoveryMessage) {
              editRecoveryMessages.push(recoveryMessage);
            }
          }
          if (isVisibleToolName(tc.name)) {
            await emitActiveExtensionEvent('tool:result', {
              id: tc.id,
              name: tc.name,
              content,
            });
            events.onToolResult?.({ id: tc.id, name: tc.name, content });
            toolResults.push(createToolResultBlock(tc.id, content));
          }
        }
      }

      // Check if any tool was cancelled by user - 检查是否有工具被用户取消
      const hasCancellation = toolResults.some(r =>
        typeof r.content === 'string' && isCancelledToolResultContent(r.content)
      );

      if (toolResults.length === 0) {
        await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
          contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          continue;
        }
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
            success: true,
            lastText,
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
          lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        break;
      }

      if (hasCancellation) {
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        // User cancelled - add results and exit loop - 用户取消，添加结果并退出循环
        messages.push({ role: 'user', content: toolResults });
        // Tool results are already appended, so emit the post-tool rebased snapshot here.
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, contextTokenSnapshot);
        }
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: 'Operation cancelled by user',
          hadToolCalls: true,
          signal: undefined,
        });
        events.onStreamEnd?.();
        await emitActiveExtensionEvent('stream:end', undefined);
        return finalizeManagedProtocolResult({
          success: true,
          lastText: 'Operation cancelled by user',
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          interrupted: !shouldYieldToQueuedFollowUp,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      if (editRecoveryMessages.length > 0) {
        messages.push({
          role: 'user',
          content: editRecoveryMessages.join('\n\n'),
          _synthetic: true,
        });
      }
      // Keep UI/context accounting aligned with the tool-result message we just appended.
      contextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
      await settleExtensionTurn(sessionId, lastText, runtimeSessionState, {
        hadToolCalls: true,
        success: true,
      });
      if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
        contextTokenSnapshot = rebaseContextTokenSnapshot(messages, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        continue;
      }

      const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
      if (shouldYieldToQueuedFollowUp) {
        emitIterationEnd(iter + 1, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        return finalizeManagedProtocolResult({
          success: true,
          lastText,
          messages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          limitReached: false,
        });
      }

      if (
        effectiveReasoningPlan.mode === 'auto' &&
        autoFollowUpCount < autoFollowUpLimit &&
        (autoDepthEscalationCount === 0 || autoTaskRerouteCount === 0) &&
        !postToolJudgeConsumed
      ) {
        const toolEvidence = summarizeToolEvidence(result.toolBlocks, toolResults);
        if (toolEvidence && hasStrongToolFailureEvidence(toolEvidence)) {
          postToolJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText,
            autoFollowUpCount,
            autoDepthEscalationCount,
            autoTaskRerouteCount,
            autoFollowUpLimit,
            events,
            isNewSession: false,
            retryLabelPrefix: 'Post-tool auto',
            toolEvidence,
            allowTaskReroute: !options.context?.disableAutoTaskReroute,
            buildExecutionState: buildReasoningExecutionState,
            persistSession: {
              sessionId,
              messages,
              title,
              runtimeSessionState,
            },
          });

          if (rerouteState) {
            ({
              reasoningPlan,
              currentExecution,
              autoFollowUpCount,
              autoDepthEscalationCount,
              autoTaskRerouteCount,
            } = rerouteState);
            continue;
          }
        }
      }

      // 保存会话
      await saveSessionSnapshot(options, sessionId, {
        messages,
        title,
        runtimeSessionState,
      });

      // Notify UI of context usage after each iteration
      emitIterationEnd(iter + 1, contextTokenSnapshot);
      await emitActiveExtensionEvent('turn:end', {
        sessionId,
        iteration: iter + 1,
        lastText,
        hadToolCalls: true,
        signal: undefined,
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // CRITICAL FIX: Always clean incomplete tool calls AND validate entire history
      // This prevents "tool_call_id not found" errors on next API call
      let cleanedMessages = cleanupIncompleteToolCalls(messages);
      cleanedMessages = validateAndFixToolHistory(cleanedMessages);

      // Update error metadata - increment consecutive error count
      const updatedErrorMetadata: SessionErrorMetadata = {
        lastError: error.message,
        lastErrorTime: Date.now(),
        consecutiveErrors: (errorMetadata?.consecutiveErrors ?? 0) + 1,
      };

      // Save session with error metadata.
      // CAP-013 known gap (P3): `saveSessionSnapshot` does NOT wrap
      // `storage.save()` in try/catch, so a storage rejection here
      // clobbers `e` and propagates instead. The substrate executor's
      // terminal hook in P3 will wrap this call in best-effort isolation.
      // Until then, `messages: cleanedMessages` (post-`cleanupIncompleteToolCalls`
      // + `validateAndFixToolHistory`) MUST be passed — raw `messages` would
      // make `/resume` reload a corrupt history.
      await saveSessionSnapshot(options, sessionId, {
        messages: cleanedMessages,
        title,
        errorMetadata: updatedErrorMetadata,
        runtimeSessionState,
      });
      contextTokenSnapshot = createEstimatedContextTokenSnapshot(cleanedMessages);

      // 检查是否为 AbortError（用户中断）
      // 参考 Gemini CLI: 静默处理中断，不报告为错误
      if (error.name === 'AbortError') {
        events.onStreamEnd?.();
        await emitActiveExtensionEvent('stream:end', undefined);

        // Issue 072 fix: 清理不完整的 tool_use 块
        // 当流式中断时，assistant 消息可能包含 tool_use 但没有对应的 tool_result
        // 这会导致下次请求时 API 报错 "tool_call_id not found"
        return finalizeManagedProtocolResult({
          success: true,  // 中断不算失败
          lastText,
          messages: cleanedMessages,
          sessionId,
          routingDecision: currentRoutingDecision(),
          contextTokenSnapshot,
          interrupted: true,
          errorMetadata: updatedErrorMetadata,
        });
      }

      await emitActiveExtensionEvent('error', { error });
      events.onError?.(error);
      return finalizeManagedProtocolResult({
        success: false,
        lastText,
        messages: cleanedMessages,  // ✅ Use cleaned messages to prevent error loop
        sessionId,
        routingDecision: currentRoutingDecision(),
        contextTokenSnapshot,
        errorMetadata: updatedErrorMetadata,
      });
    }
  }

  // 达到迭代上限 - 循环完成所有迭代没有提前退出
  // 如果代码执行到这里，说明循环正常结束（没有 COMPLETE、中断或错误）
  limitReached = true;

  // 最终保存
  await saveSessionSnapshot(options, sessionId, {
    messages,
    title,
    runtimeSessionState,
  });

  // 检查最终信号
  const [finalSignal, finalReason] = checkPromiseSignal(lastText);

  // 达到迭代上限 (循环正常结束但没有 COMPLETE 信号且没有提前退出)
  // 使用 limitReached 变量来准确判断
  return finalizeManagedProtocolResult({
    success: true,
    lastText,
    signal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    signalReason: finalReason,
    messages,
    sessionId,
    routingDecision: currentRoutingDecision(),
    contextTokenSnapshot,
    limitReached,
  });
  } finally {
    releaseRuntimeBinding?.();
    if (options.extensionRuntime && (options.extensionRuntime as KodaXExtensionRuntime) !== previousActiveRuntime) {
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

// 导出工具函数
export { cleanupIncompleteToolCalls, validateAndFixToolHistory };
