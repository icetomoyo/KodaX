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
import { listToolDefinitions } from './tools/index.js';
import { mergeManagedProtocolPayload } from './managed-protocol.js';
// CAP-075 (`getManagedBlockNameForRole`, `hasManagedProtocolForRole`,
// `textContainsManagedBlock`, `MANAGED_PROTOCOL_TOOL_NAME`) is wired
// inside `agent-runtime/managed-protocol-continue.ts` since FEATURE_100 P3.5b.
import { generateSessionId, extractTitleFromMessages } from './session.js';
// FEATURE_076 Q4: load-time normalization for pre-v0.7.25 session messages.
import { normalizeLoadedSessionMessages } from './task-engine/_internal/round-boundary.js';
import { microcompact, DEFAULT_MICROCOMPACTION_CONFIG, type CompactionConfig } from '@kodax/agent';
import { loadCompactionConfig } from './compaction-config.js';
// CAP-014/060/061/062 token estimation now happens inside the
// substrate compaction modules; agent.ts no longer imports
// `estimateTokens` directly since FEATURE_100 P3.4c.
// CAP-074 (KODAX_MAX_MAXTOKENS_RETRIES) is consumed inside
// `agent-runtime/max-tokens-continuation.ts` since FEATURE_100 P3.5a.
import { waitForRetryDelay } from './retry-handler.js';
import { telemetryRecovery } from './resilience/index.js';
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
import { resolveExecutionCwd, resolveExecutionPath } from './runtime-paths.js';
import {
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
} from './repo-intelligence/runtime.js';
import {
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  rebaseContextTokenSnapshot,
  resolveContextTokenCount,
} from './token-accounting.js';
// CAP-082 (`createEstimatedContextTokenSnapshot`) is consumed inside
// `agent-runtime/catch-terminals.ts:runCatchCleanup` since FEATURE_100 P3.5d.
// CAP-079 (`applyToolResultGuardrail`) is now wired inside
// `agent-runtime/tool-dispatch.ts:runToolDispatch` since FEATURE_100 P3.3d.
// CAP-002 (`cleanupIncompleteToolCalls`, `validateAndFixToolHistory`) is
// consumed inside `agent-runtime/catch-terminals.ts:runCatchCleanup`
// since FEATURE_100 P3.5d. Both are still re-exported below for the
// public agent.ts barrel.
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
import {
  isVisibleToolName,
  hasQueuedFollowUp,
  emitIterationStart as emitIterationStartStep,
  emitIterationEnd as emitIterationEndStep,
} from './agent-runtime/event-emitter.js';
import { resolvePerTurnProvider } from './agent-runtime/per-turn-provider-resolution.js';
import { resolvePerTurnReasoning } from './agent-runtime/per-turn-reasoning.js';
import { buildStreamTimers } from './agent-runtime/stream-timers.js';
import { applyProviderPolicyGate } from './agent-runtime/provider-policy-gate.js';
import { buildStreamHandlers } from './agent-runtime/stream-handler-wiring.js';
import { BoundaryTrackerSession } from './agent-runtime/boundary-tracker-session.js';
import {
  buildResilienceSession,
  translateAbortError,
  runRecoveryPipeline,
} from './agent-runtime/provider-retry-policy.js';
import { executeNonStreamingFallback } from './agent-runtime/non-streaming-fallback.js';
import { guardEmptyAssistantContent } from './agent-runtime/assistant-message-builder.js';
import { checkAndRetryIncompleteTools } from './agent-runtime/incomplete-tool-retry.js';
import {
  checkPreToolAbort,
  hasCancelledToolResult,
  applyCancellationTerminal,
  CANCELLATION_LAST_TEXT,
} from './agent-runtime/tool-cancellation.js';
import { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
// CAP-037 predicates (`isToolResultErrorContent`) consumed inside the
// dispatch substrate (CAP-024 / CAP-078) since FEATURE_100 P3.3d.
import {
  filterExcludedTools,
  getActiveToolDefinitions,
  getRuntimeActiveToolNames,
} from './agent-runtime/tool-resolution.js';
// CAP-028 / CAP-062 (`gracefulCompactDegradation`) is wired inside
// `agent-runtime/middleware/compaction-orchestration.ts` since
// FEATURE_100 P3.4c.
import { shouldCompact } from './agent-runtime/compaction-trigger.js';
import { runCompactionLifecycle } from './agent-runtime/middleware/compaction-orchestration.js';
import { maybeContinueAfterMaxTokens } from './agent-runtime/max-tokens-continuation.js';
import { maybeAutoContinueManagedProtocol } from './agent-runtime/managed-protocol-continue.js';
import { applyIterationLimitTerminal } from './agent-runtime/iteration-limit-terminal.js';
import {
  runCatchCleanup,
  applyAbortErrorTerminal,
  applyGenericErrorTerminal,
} from './agent-runtime/catch-terminals.js';
// CAP-026 (`updateToolOutcomeTracking`) is now wired inside
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` since
// FEATURE_100 P3.3d.
import {
  type ProviderPrepareState,
  applyProviderPrepareHook,
} from './agent-runtime/provider-hook.js';
import {
  runToolDispatch,
  applyPostToolProcessing,
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
// CAP-015 (`buildEditRecoveryUserMessage`, `RunnableToolCall`) and
// CAP-016 mutation-reflection helpers are wired inside
// `agent-runtime/tool-dispatch.ts:applyPostToolProcessing` since
// FEATURE_100 P3.3d.
import {
  hasStrongToolFailureEvidence,
  isReviewFinalAnswerCandidate,
  summarizeToolEvidence,
} from './agent-runtime/middleware/judges.js';
import { maybeAdvanceAutoReroute } from './agent-runtime/middleware/auto-reroute.js';
import {
  appendQueuedRuntimeMessages,
  createExtensionRuntimeSessionController,
  pushToolResultsAndSettle,
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

  let incompleteRetryCount = 0;

  // FEATURE_100 P3.6b/d — seven per-loop counters/latches/accumulators
  // consolidated into one mutable accumulator. The substrate executor
  // (P3.6e) will absorb these into TurnContext fields. The object
  // reference is stable; only its fields mutate, so closures (e.g.
  // `events.getCostReport.current`) that capture `turnState` see the
  // current values at call time.
  //
  // `turnState.lastText` is the assistant's most-recent response text — used by
  // judges, terminals, and signal extraction. Folded into `turnState`
  // in P3.6d so the substrate's PER_STEP tier mirrors what TurnContext
  // already declares (turn-context.ts:158).
  const turnState = {
    preAnswerJudgeConsumed: false,
    postToolJudgeConsumed: false,
    maxTokensRetryCount: 0,
    costTracker: createCostTracker() as CostTracker,
    managedProtocolContinueAttempted: false,
    compactConsecutiveFailures: 0,
    lastText: '',
  };
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
      maxIter,
      messages,
      currentSnapshot: contextTokenSnapshot,
      snapshotOverride,
    });
    return contextTokenSnapshot;
  };
  const currentRoutingDecision = () => reasoningPlan.decision;
    events.onSessionStart?.({ provider: initialProvider.name, sessionId });
    await emitActiveExtensionEvent('session:start', { provider: initialProvider.name, sessionId });

    // Cost tracking — lightweight session-scoped tracker. The closure
    // captures the stable `turnState` reference; reads see the latest
    // tracker value at call time (recordUsage produces a new value each
    // turn, written back via `turnState.costTracker = ...`).
    if (events.getCostReport) {
      events.getCostReport.current = () => formatCostReport(getSummary(turnState.costTracker));
    }

    for (let iter = 0; iter < maxIter; iter++) {
    try {
      // CAP-055: per-turn provider/model/thinkingLevel re-resolution +
      // CAP-042 per-turn isConfigured check + CAP-056 contextWindow cascade.
      const turnProvider = resolvePerTurnProvider(
        runtimeSessionState,
        options,
        compactionConfig,
      );
      currentProviderName = turnProvider.providerName;
      currentModelOverride = turnProvider.modelOverride;
      runtimeThinkingLevel = turnProvider.thinkingLevel;
      const provider = turnProvider.provider;
      const contextWindow = turnProvider.contextWindow;

      // CAP-057: per-turn effectiveReasoningPlan + currentExecution rebuild.
      const turnReasoning = await resolvePerTurnReasoning({
        options,
        providerName: currentProviderName,
        modelOverride: currentModelOverride,
        thinkingLevel: runtimeThinkingLevel,
        reasoningPlan,
        messages,
      });
      const effectiveReasoningPlan = turnReasoning.effectiveReasoningPlan;
      currentExecution = turnReasoning.currentExecution;

      await emitActiveExtensionEvent('turn:start', {
        sessionId,
        iteration: iter + 1,
        maxIter,
      });
      // CAP-058: user-facing iteration-start event.
      emitIterationStartStep(events, iter, maxIter);

      // Microcompaction: lightweight cleanup each turn (no LLM calls)
      // Clears old tool results, thinking blocks, and image blocks
      messages = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG) as KodaXMessage[];

      // CAP-059/060/061/062/063: compaction lifecycle (trigger gate +
      // LLM compact + post-compact attachments + graceful degradation +
      // validate/commit). The orchestrator returns the next-turn
      // counter and a fresh contextTokenSnapshot only when compaction
      // actually fired.
      const currentTokens = resolveContextTokenCount(messages, contextTokenSnapshot);
      const needsCompact = shouldCompact({
        messages,
        compactionConfig,
        contextWindow,
        currentTokens,
      });
      const compactionLifecycle = await runCompactionLifecycle({
        messages,
        needsCompact,
        compactConsecutiveFailures: turnState.compactConsecutiveFailures,
        compactionConfig,
        provider,
        contextWindow,
        systemPrompt: currentExecution.systemPrompt,
        currentTokens,
        events,
      });
      messages = compactionLifecycle.messages;
      turnState.compactConsecutiveFailures = compactionLifecycle.nextCompactConsecutiveFailures;
      if (compactionLifecycle.contextTokenSnapshot !== undefined) {
        contextTokenSnapshot = compactionLifecycle.contextTokenSnapshot;
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
      // CAP-064: provider-policy gate — throws on block status, produces
      // the effective system prompt with any policy issue notes appended.
      const { effectiveSystemPrompt } = applyProviderPolicyGate({
        providerName: currentProviderName,
        model: currentModelOverride,
        provider: streamProvider,
        prompt,
        effectiveOptions: currentExecution.effectiveOptions,
        reasoningMode: effectiveProviderReasoningMode,
        taskType: effectiveReasoningPlan.decision.primaryTask,
        executionMode: effectiveReasoningPlan.decision.recommendedMode,
        baseSystemPrompt: preparedProviderState.systemPrompt,
      });
      if (!streamProvider.isConfigured()) {
        throw new Error(
          `Provider "${currentProviderName}" not configured. Set ${streamProvider.getApiKeyEnv()}`,
        );
      }

      await emitActiveExtensionEvent('provider:selected', {
        provider: currentProviderName,
        model: currentModelOverride,
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
        currentProviderName,
        streamProvider,
        boundaryTracker,
      );
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs; // Issue 084: 10-min hard timeout
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs; // Issue 084: 60s idle, reset on delta
      let providerMessages = messages;
      let result!: KodaXStreamResult;
      let attempt = 0;
      const activeToolDefinitions = getActiveToolDefinitions(
        runtimeSessionState.activeTools,
        options.context?.repoIntelligenceMode,
        options.context?.managedProtocolEmission?.enabled === true,
        !!runtime,
        options.context?.toolConstructionMode,
      );

      while (true) {
        attempt += 1;
        boundarySession.beginAttempt(
          currentProviderName,
          currentModelOverride ?? streamProvider.getModel(),
          providerMessages,
          attempt,
          false,
        );

        // CAP-066: stream-timer lifecycle (hard / max-duration / idle +
        // merged retrySignal). All three timers fire into a single
        // retryTimeoutController; clearAll() must run on every exit.
        const streamTimers = buildStreamTimers({
          hardTimeoutMs: API_HARD_TIMEOUT_MS,
          idleTimeoutMs: API_IDLE_TIMEOUT_MS,
          streamMaxDurationMs: streamProvider.getStreamMaxDurationMs?.() ?? 0,
          callerAbortSignal: options.abortSignal,
        });
        const retryTimeoutController = streamTimers.retryTimeoutController;
        const retrySignal = streamTimers.retrySignal;
        const resetIdleTimer = streamTimers.resetIdleTimer;

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
          // CAP-067: build the 6-handler callback bag (delta / thinking-end /
          // tool-input / rate-limit / heartbeat). All handlers fan out to
          // streamTimers.resetIdleTimer() + boundaryTracker + extension
          // events + consumer events in load-bearing order.
          const streamCallbacks = buildStreamHandlers({
            events,
            boundaryTracker,
            streamTimers,
            emitActiveExtensionEvent,
            providerName: currentProviderName,
          });
          result = await streamProvider.stream(
            providerMessages,
            activeToolDefinitions,
            effectiveSystemPrompt,
            effectiveProviderReasoning,
            {
              ...streamCallbacks,
              modelOverride: currentModelOverride,
              signal: retrySignal,
            },
            retrySignal,
          );

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
            const fallbackBytes = estimateProviderPayloadBytes(providerMessages, effectiveSystemPrompt);
            emitResilienceDebug('[resilience:fallback]', {
              provider: currentProviderName,
              attempt,
              payloadBytes: fallbackBytes,
              payloadBucket: bucketProviderPayloadSize(fallbackBytes),
            });

            // CAP-071: non-streaming fallback. On success, the outer
            // attempt loop must `break` with the buffered result. On
            // failure, fall through to recovery-action branches with
            // the new error.
            const fallbackOutcome = await executeNonStreamingFallback({
              events,
              streamProvider,
              providerMessages,
              activeToolDefinitions,
              effectiveSystemPrompt,
              effectiveProviderReasoning,
              callerAbortSignal: options.abortSignal,
              modelOverride: currentModelOverride,
              hardTimeoutMs: API_HARD_TIMEOUT_MS,
              boundarySession,
              emitActiveExtensionEvent,
              providerName: currentProviderName,
              attempt,
              clearStreamTimers: streamTimers.clearAll,
            });
            if (fallbackOutcome.ok) {
              result = fallbackOutcome.result;
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

          streamTimers.clearAll();
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          streamTimers.clearAll();
        }
      }

      // 流式输出结束，通知 CLI 层
      events.onStreamEnd?.();
      await emitActiveExtensionEvent('stream:end', undefined);

      // Record cost for this LLM call
      if (result.usage) {
        turnState.costTracker = recordUsage(turnState.costTracker, {
          provider: currentProviderName,
          model: currentModelOverride ?? 'unknown',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cachedReadTokens,
          cacheWriteTokens: result.usage.cachedWriteTokens,
        });
      }

      turnState.lastText = result.textBlocks.map(b => b.text).join(' ');
      const preAssistantTokenSnapshot = createContextTokenSnapshot(messages, result.usage);
      const visibleToolBlocks = result.toolBlocks.filter((block) => isVisibleToolName(block.name));

      // Promise 信号检测
      const [signal, _reason] = checkPromiseSignal(turnState.lastText);
      if (signal) {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
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
            lastText: turnState.lastText,
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
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: 'COMPLETE',
          });
          events.onComplete?.();
          await emitActiveExtensionEvent('complete', { success: true, signal: 'COMPLETE' });
          return finalizeManagedProtocolResult({
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
      // tool calls (e.g. emit_managed_protocol) with no text/thinking,
      // replace the empty array with a single '...' placeholder so
      // providers that reject empty content (Kimi 400) don't trip.
      const assistantContent = guardEmptyAssistantContent([
        ...result.thinkingBlocks,
        ...result.textBlocks,
        ...visibleToolBlocks,
      ]);
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
      // CAP-074: L5 max_tokens continuation. Synthetic "resume mid-thought"
      // user message capped at KODAX_MAX_MAXTOKENS_RETRIES; skipped when
      // tool_blocks are present (partial-JSON salvage handles those naturally).
      const maxTokensOutcome = maybeContinueAfterMaxTokens({
        result,
        messages,
        maxTokensRetryCount: turnState.maxTokensRetryCount,
        completedTurnTokenSnapshot,
        events,
      });
      turnState.maxTokensRetryCount = maxTokensOutcome.nextMaxTokensRetryCount;
      if (maxTokensOutcome.outcome === 'continue') {
        contextTokenSnapshot = maxTokensOutcome.nextContextTokenSnapshot;
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
        emittedManagedProtocolPayload,
        completedTurnTokenSnapshot,
      });
      turnState.managedProtocolContinueAttempted = protocolContinueOutcome.nextContinueAttempted;
      if (protocolContinueOutcome.outcome === 'continue') {
        contextTokenSnapshot = protocolContinueOutcome.nextContextTokenSnapshot;
        continue;
      }

      if (result.toolBlocks.length === 0) {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
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
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
            success: true,
            lastText: turnState.lastText,
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
          !turnState.preAnswerJudgeConsumed &&
          isReviewFinalAnswerCandidate(prompt, effectiveReasoningPlan, turnState.lastText)
        ) {
          turnState.preAnswerJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText: turnState.lastText,
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
          lastText: turnState.lastText,
          hadToolCalls: false,
          signal: undefined,
        });
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        // CAP-085 (clean-exit variant): natural completion path. We still
        // run the iter-terminal helper so the final snapshot save + signal
        // extraction match the pre-FEATURE_100 byte-for-byte behavior, but
        // return with `limitReached: false` — this is a model-driven
        // completion, NOT iteration-budget exhaustion. Without the explicit
        // `false` flag, downstream `scout-signals.ts` would mis-tag this as
        // 'budget-exhausted'.
        {
          const iterTerminal = await applyIterationLimitTerminal({
            options,
            sessionId,
            messages,
            title,
            runtimeSessionState,
            lastText: turnState.lastText,
          });
          return finalizeManagedProtocolResult({
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
        // CAP-077 + CAP-079: parallel non-bash / sequential bash dispatch
        // wrapped via the post-tool truncation guardrail.
        const resultMap = await runToolDispatch({
          toolBlocks: result.toolBlocks,
          events,
          ctx,
          runtimeSessionState,
          activeToolNames: getRuntimeActiveToolNames(
            runtimeSessionState.activeTools,
            options.context?.repoIntelligenceMode,
            !!runtime,
            options.context?.toolConstructionMode,
          ),
          abortSignal: options.abortSignal,
        });
        // CAP-078: per-result post-processing chain (mutation reflection,
        // outcome tracking, edit recovery, visibility events).
        const postProcessed = await applyPostToolProcessing({
          toolBlocks: result.toolBlocks,
          resultMap,
          events,
          emitActiveExtensionEvent,
          ctx,
          runtimeSessionState,
        });
        toolResults = postProcessed.toolResults;
        editRecoveryMessages = postProcessed.editRecoveryMessages;
      }

      // CAP-080: any cancelled tool result triggers the cancellation
      // terminal branch below. Pre-tool aborts (CAP-076) and bash-loop
      // mid-execution aborts (CAP-077) both surface here.
      const hasCancellation = hasCancelledToolResult(toolResults);

      if (toolResults.length === 0) {
        await settleExtensionTurn(sessionId, turnState.lastText, runtimeSessionState, {
          hadToolCalls: false,
          success: true,
        });
        if (appendQueuedRuntimeMessages(messages, runtimeSessionState)) {
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
        const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
        if (shouldYieldToQueuedFollowUp) {
          emitIterationEnd(iter + 1, completedTurnTokenSnapshot);
          await emitActiveExtensionEvent('turn:end', {
            sessionId,
            iteration: iter + 1,
            lastText: turnState.lastText,
            hadToolCalls: false,
            signal: undefined,
          });
          return finalizeManagedProtocolResult({
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
        events.onComplete?.();
        await emitActiveExtensionEvent('complete', { success: true, signal: undefined });
        // CAP-085 (clean-exit variant): natural completion path after a
        // tool turn returned no tool_use blocks. Same routing as the
        // text-only break above — run the iter-terminal helper for
        // snapshot save + signal extraction, return with
        // `limitReached: false` so downstream `scout-signals.ts` does NOT
        // mis-tag this as 'budget-exhausted'.
        {
          const iterTerminal = await applyIterationLimitTerminal({
            options,
            sessionId,
            messages,
            title,
            runtimeSessionState,
            lastText: turnState.lastText,
          });
          return finalizeManagedProtocolResult({
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
          iter,
          emitIterationEnd,
        });
        contextTokenSnapshot = cancellationTerminal.contextTokenSnapshot;
        return finalizeManagedProtocolResult({
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
      contextTokenSnapshot = settleOutcome.contextTokenSnapshot;
      if (settleOutcome.drainedQueuedMessages) {
        continue;
      }

      const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(events);
      if (shouldYieldToQueuedFollowUp) {
        emitIterationEnd(iter + 1, contextTokenSnapshot);
        await emitActiveExtensionEvent('turn:end', {
          sessionId,
          iteration: iter + 1,
          lastText: turnState.lastText,
          hadToolCalls: true,
          signal: undefined,
        });
        return finalizeManagedProtocolResult({
          success: true,
          lastText: turnState.lastText,
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
        !turnState.postToolJudgeConsumed
      ) {
        const toolEvidence = summarizeToolEvidence(result.toolBlocks, toolResults);
        if (toolEvidence && hasStrongToolFailureEvidence(toolEvidence)) {
          turnState.postToolJudgeConsumed = true;
          const rerouteState = await maybeAdvanceAutoReroute({
            provider,
            options,
            prompt,
            reasoningPlan: effectiveReasoningPlan,
            lastText: turnState.lastText,
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
        lastText: turnState.lastText,
        hadToolCalls: true,
        signal: undefined,
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // CAP-082: cleanup chain — ALWAYS runs first in the catch branch.
      // Cleans incomplete tool calls + validates history (Issue 072
      // prevention), increments consecutiveErrors, persists snapshot
      // with cleaned messages, rebases the context-token snapshot.
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

      // CAP-083: AbortError silent terminal. Per Gemini CLI parity,
      // user interrupts return success:true with interrupted flag.
      if (error.name === 'AbortError') {
        await applyAbortErrorTerminal({ events, emitActiveExtensionEvent });
        return finalizeManagedProtocolResult({
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

      // CAP-084: generic error terminal. Emits `error` event +
      // events.onError; returns success:false with the cleaned
      // messages so a follow-up resume doesn't reload corrupt history.
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
    }
  }

  // CAP-085: iteration-limit terminal — natural for-loop exhaustion.
  // Runs the final snapshot save + signal extraction; the caller wraps
  // with `finalizeManagedProtocolResult` and returns with
  // `limitReached: true`. This branch is reached ONLY when every iter
  // is consumed without an early `return`. The two model-driven
  // completion paths (text-only turn, tools-with-no-results turn) also
  // call `applyIterationLimitTerminal` to preserve the snapshot+signal
  // side effects byte-for-byte, but return with `limitReached: false`
  // — see the call sites above guarded by `events.onComplete?.()`.
  const iterTerminal = await applyIterationLimitTerminal({
    options,
    sessionId,
    messages,
    title,
    runtimeSessionState,
    lastText: turnState.lastText,
  });
  return finalizeManagedProtocolResult({
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
