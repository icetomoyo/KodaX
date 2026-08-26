/**
 * KodaX Core Types
 *
 * 核心类型定义 - 重新导出 @kodax-ai/agent 类型 + Coding 特定类型
 */

// ============== Import from @kodax-ai/agent ==============
// 通用 Agent 类型从 @kodax-ai/agent 导入

// FEATURE_221: SDK consumers inject their own product manual topics.
import type { KodaXManualTopicId, KodaXManualTopicInput } from './self-knowledge/types.js';
import type { KodaXTimeoutConfig } from './timeouts.js';
import type { RuntimeContextBudgetSnapshot } from './agent-runtime/context-budget.js';
import type { RuntimeToolExposurePlan } from './agent-runtime/tool-exposure-planner.js';
import type { KodaXOutputSegmentStarted } from './output-segments.js';
import type {
  CompactionSkipReason,
  RuntimeCompactionSkippedEvent,
} from './agent-runtime/middleware/compaction-pressure.js';
import type { MemoryRecallRunner } from '@kodax-ai/agent/experimental-memory';

import type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXMemoryOutcomeDigest,
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
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
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
  KodaXSessionScope,
  KodaXSessionMeta,
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
  MemoryReviewPlan,
  MemoryReviewRunner,
  UnifiedLearningReviewRunner,
  MemoryContextIdentity,
  MemoryPack,
  SessionErrorMetadata,
  WorkflowIsolation,
  WorkflowEvent,
  WorkflowEventCorrelation,
  WorkflowProcessEvent,
  SkillDynamicContextExecutor,
  ISkillRegistry,
  AgentExecutorPlaneBinding,
  AgentActorClient,
  AgentExecutionResult,
  AgentTurnExecutor,
} from '@kodax-ai/agent';
// v0.7.35.1 FEATURE_142 (A-R4): AMA / harness types live in @kodax-ai/llm
// (coding-AMA vocabulary; see ADR-021). Imported directly here instead of
// going through @kodax-ai/agent's re-export, which has been removed.
import type {
  KodaXHarnessProfile,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXStableEffortIntent,
  KodaXWireReasoningEffort,
  KodaXReasoningEffortRequest,
  KodaXReasoningEffortPreset,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXReasoningProfile,
  KodaXNormalizedReasoningRequest,
} from '@kodax-ai/llm';
import type { CompactionUpdate } from '@kodax-ai/agent';
// FEATURE_093 (v0.7.24): use the narrow runtime contract from
// `./extensions/runtime-contract.ts` to avoid `types.ts ↔ extensions/runtime.ts`
// circular imports. The concrete `KodaXExtensionRuntime` class implements
// this contract plus ~40 internal methods that consumers do not reach
// through Options / ToolExecutionContext fields.
import type {
  CapabilityRuntimeContract,
  ExtensionRuntimeContract,
} from './extensions/runtime-contract.js';
import type {
  FailureStage,
  ResilienceErrorClass,
  RecoveryAction,
  RecoveryLadderStep,
} from './resilience/types.js';
// FEATURE_247 (R2): the tool-visibility policy predicates on the stable
// `sideEffect` contract. Imported from the leaf `./tools/side-effect.js` (not
// `./tools/types.js`) so there is no import cycle — `tools/types.ts` imports
// `KodaXToolExecutionContext` back from here.
import type { ToolSideEffect } from './tools/side-effect.js';
import type { KodaXAgentScope } from './construction/agent-resolver.js';

// Re-export all types from @kodax-ai/agent
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
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXNormalizedReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXFileInputArtifact,
  KodaXImageInputArtifact,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXVideoInputArtifact,
  KodaXVideoMediaType,
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
  KodaXSessionScope,
  KodaXSessionMeta,
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
  WorkflowEventCorrelation,
  WorkflowProcessEvent,
};

// ============== 事件接口 ==============

export interface KodaXWorkflowEventMeta {
  readonly workflowCorrelation?: WorkflowEventCorrelation;
}

export type KodaXTurnDeliveryKind = 'initial' | 'queued' | 'interrupt' | 'resume';

export interface KodaXContextIdentity {
  readonly contextId: string;
  readonly contextKind: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly contextRevision: number;
}

export interface KodaXLiveEventMeta extends Partial<KodaXContextIdentity> {
  readonly sessionId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly deliveryId?: string;
  readonly timestamp?: string;
}

export interface KodaXTurnStartedEvent extends KodaXLiveEventMeta {
  readonly promptId?: string;
  readonly deliveryKind: KodaXTurnDeliveryKind;
}

export interface KodaXTurnCompletedEvent extends KodaXLiveEventMeta {
  readonly status: 'completed' | 'cancelled' | 'interrupted';
}

export interface KodaXTurnFailedEvent extends KodaXLiveEventMeta {
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

export interface KodaXActivityEventMeta extends KodaXWorkflowEventMeta, Partial<KodaXLiveEventMeta> {
  /** Physical provider request currently producing this live output. */
  readonly providerRequestId?: string;
  readonly childAgentId?: string;
  readonly childAgentName?: string;
  readonly parentToolId?: string;
  readonly liveOnly?: boolean;
  /**
   * FEATURE_247 (R8) — session id this event belongs to. Lets a host that runs
   * concurrent Partner/Coder sessions attribute a streamed event to the right
   * session. Absent on paths that do not yet thread the resolved session id.
   */
  readonly sessionId?: string;
  /** Exact queue identities consumed by a mid-turn user-message boundary. */
  readonly queuedMessageIds?: readonly string[];
  /** Exact durable lineage entry created for each consumed queue identity. */
  readonly queuedMessageEntryIds?: Readonly<Record<string, string>>;
  /**
   * FEATURE_247 (R8) — SDK-consumer agent profile that produced this event.
   * Absent ⇒ default Coding Agent (or an event emitted before a profile is known).
   */
  readonly agentProfile?: KodaXAgentProfile;
}

/**
 * ADR-049: a single workflow child agent reached a terminal/summary state during
 * an inline `run_workflow` run. The raw `WorkflowEvent` is forwarded (not a
 * pre-formatted string) so the REPL renders it with its own
 * `formatWorkflowAgentDigest` — keeping digest formatting in the UI layer and the
 * coding layer free of presentation logic.
 */
export interface KodaXWorkflowAgentDigestEvent {
  readonly runId: string;
  readonly event: WorkflowEvent;
}

export interface KodaXToolEventMeta extends KodaXActivityEventMeta {
  readonly toolId?: string;
}

export type KodaXShellSandboxBackend =
  | 'windows-restricted-user'
  | 'macos-seatbelt'
  | 'linux-bubblewrap'
  | 'unsupported';

export type KodaXShellSandboxObservation =
  | {
      readonly version: 1;
      readonly state: 'applied';
      readonly backend: KodaXShellSandboxBackend;
      readonly policyId: 'kodax-workspace-shell-v1';
    }
  | {
      readonly version: 1;
      readonly state: 'fallback';
      readonly reason:
        | 'not_ready'
        | 'prepare_failed'
        | 'backend_failed'
        | 'session_reset_pending'
        | 'acl_transition_pending';
      readonly execution: 'normal_permission_policy';
    }
  | {
      readonly version: 1;
      readonly state: 'not_selected';
    };

export interface KodaXToolSandboxObservationUpdate {
  readonly id: string;
  readonly observation: KodaXShellSandboxObservation;
}

export interface KodaXContextCompactionFinishedEvent
  extends Partial<KodaXLiveEventMeta> {
  readonly source: 'manual' | 'automatic_threshold' | 'physical_capacity';
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly committed: boolean;
  readonly elapsedMs: number;
  readonly strategy?: 'full_prefix' | 'map_reduce';
  readonly effectiveTriggerTokens?: number;
  readonly protectedBudgetTokens?: number;
  readonly fixedInputTokens?: number;
  readonly eligibleTokens?: number;
  readonly rawTailTokens?: number;
  readonly summaryTokens?: number;
  readonly queryLedgerTokens?: number;
}

export type KodaXCompactionFailureReason =
  | 'summary_generation_failed'
  | 'persistence_failed'
  | 'context_capacity_exceeded'
  | 'post_processing_failed';

export interface KodaXCompactionEndState {
  readonly currentTokens: number;
  readonly compactableTokens: number;
  readonly consecutiveFailures: number;
  readonly circuitBreakerLimit: number;
  readonly circuitBreakerState: 'closed' | 'open' | 'half_open';
  readonly cooldownTurnsRemaining: number;
}

/** Structured outcome attached to the existing compaction-ended lifecycle event. */
export type KodaXCompactionEndResult = KodaXCompactionEndState & (
  | {
      readonly outcome: 'compacted';
      readonly reason?: never;
      readonly failurePhase?: never;
    }
  | {
      readonly outcome: 'skipped';
      readonly reason: CompactionSkipReason;
      readonly failurePhase?: never;
    }
  | {
      readonly outcome: 'failed';
      readonly reason: 'summary_generation_failed';
      readonly failurePhase: 'summary_generation';
    }
  | {
      readonly outcome: 'failed';
      readonly reason: 'persistence_failed';
      readonly failurePhase: 'persistence';
    }
  | {
      readonly outcome: 'failed';
      readonly reason: 'post_processing_failed';
      readonly failurePhase: 'post_processing';
    }
  | {
      readonly outcome: 'failed';
      readonly reason: 'context_capacity_exceeded';
      readonly failurePhase?: never;
    }
);

export interface KodaXSidecarMessageEvent {
  readonly source: 'sidecar-verifier';
  readonly verdict: 'revise' | 'blocked';
  readonly recipient: 'main-agent' | 'user';
  readonly delivery: 'synthetic-user-message' | 'budget-exhausted' | 'terminal-block';
  /** Exact actionable text from the sidecar. `budget-exhausted` means it was not injected. */
  readonly content: string;
  readonly suggestedFix?: string;
  readonly strategyReasonCode?:
    | 'missing_requirement'
    | 'contradicted_evidence'
    | 'unsupported_claim'
    | 'unresolved_high_risk'
    | 'verification_degraded';
  readonly recommendedPattern?:
    | 'classify-and-act'
    | 'fan-out-and-synthesize'
    | 'adversarial-verification'
    | 'generate-and-filter'
    | 'tournament'
    | 'loop-until-done';
  readonly targetEvidenceRefs?: readonly string[];
  readonly trace?: string;
  /**
   * FEATURE_247 (R3/R8) — session id the verdict belongs to, so a host running
   * concurrent Partner/Coder sessions can correlate a sidecar verdict to the
   * right session. Absent when the resolved session id is not available.
   */
  readonly sessionId?: string;
  /**
   * FEATURE_247 (R3/R8) — SDK-consumer agent profile whose output was verified.
   * Absent ⇒ default Coding Agent.
   */
  readonly agentProfile?: KodaXAgentProfile;
}

export interface KodaXTodoDriftWarningEvent {
  readonly kind: 'work_started_without_claimed_todo';
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly count: number;
  readonly pendingCount: number;
  readonly openCount: number;
  readonly firstPendingTodoId?: string;
  readonly firstPendingTodoSubject?: string;
}

export interface KodaXPromptCacheDiagnosticEvent {
  readonly phase: 'request' | 'response';
  /** Provider API path used for this physical request. */
  readonly transport?: 'stream' | 'complete';
  readonly requestId: string;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly provider: string;
  /** Stable logical Runtime context. Prompt/message text is never included. */
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  /** Caller-facing model id selected for this request. */
  readonly model: string;
  /** Exact provider wire model after alias resolution. */
  readonly wireModel?: string;
  /** Hash of the caller-level reasoning controls; never contains prompt text. */
  readonly reasoningHash?: string;
  /** Effective output reservation sent for this adapter request. */
  readonly maxOutputTokens?: number;
  /** Whether KodaX explicit prompt-cache controls are enabled. */
  readonly kodaxPromptCacheEnabled?: boolean;
  /** Credential-free provider origin. */
  readonly endpoint?: string;
  /** Hash of the endpoint path, which may itself contain tenant credentials. */
  readonly endpointPathHash?: string;
  readonly attempt: number;
  readonly systemPromptHash: string;
  readonly toolSchemaHash: string;
  /** Hash of provider-visible messages before the current turn starts. */
  readonly messagePrefixHash: string;
  readonly messagePrefixCount: number;
  /** Hash of persistent provider-visible messages, excluding any ephemeral suffix. */
  readonly requestMessagesHash: string;
  /** Composite hash of system, tools, persistent messages, and ephemeral suffix. */
  readonly requestEnvelopeHash: string;
  /** Hash of provider-visible ephemeral request suffixes, when present. */
  readonly ephemeralSuffixHash?: string;
  /** Hash of the opaque affinity key when this Provider applies it on wire. */
  readonly promptCacheAffinityHash?: string;
  readonly messageCount: number;
  readonly toolCount: number;
  /** Provider-reported usage only. Missing fields remain undefined. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

export interface KodaXUserInputPromptContext {
  /** Aborted when the Runtime resolves, expires, or dismisses the interaction. */
  readonly signal: AbortSignal;
}

export interface KodaXEvents {
  /** FEATURE_229: correlates child-agent SDK callbacks back to a workflow run/item. */
  workflowCorrelation?: WorkflowEventCorrelation;
  // 流式输出
  onOutputSegmentStart?: (
    segment: KodaXOutputSegmentStarted,
    meta?: KodaXActivityEventMeta,
  ) => void;
  onTextDelta?: (text: string, meta?: KodaXActivityEventMeta) => void;
  onThinkingDelta?: (text: string, meta?: KodaXActivityEventMeta) => void;
  onThinkingEnd?: (thinking: string, meta?: KodaXActivityEventMeta) => void;
  onToolUseStart?: (
    tool: { name: string; id: string; input?: Record<string, unknown> },
    meta?: KodaXToolEventMeta,
  ) => void;
  onToolResult?: (
    result: { id: string; name: string; content: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  /** Internal execution lease boundary; fires immediately around tool.execute. */
  onToolExecutionStart?: (
    tool: { id: string; name: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  /** Pairs with onToolExecutionStart in a finally block. */
  onToolExecutionEnd?: (
    tool: { id: string; name: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  /** FEATURE_067 v2: Real-time tool execution progress update. Updates the tool's display in the REPL transcript. */
  onToolProgress?: (
    update: { id: string; message: string },
    meta?: KodaXToolEventMeta,
  ) => void;
  /**
   * Execution metadata for professional hosts. REPL history intentionally does
   * not render this internal containment state.
   */
  onToolSandboxObservation?: (
    update: KodaXToolSandboxObservationUpdate,
    meta?: KodaXToolEventMeta,
  ) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: KodaXToolEventMeta,
  ) => void;
  onStreamEnd?: (meta?: KodaXActivityEventMeta) => void;
  /** Fired once when a child-agent run fully leaves the child executor. */
  onChildActivityEnd?: (meta?: KodaXActivityEventMeta) => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string } & Partial<KodaXLiveEventMeta>) => void;
  onTurnStarted?: (event: KodaXTurnStartedEvent) => void;
  onTurnCompleted?: (event: KodaXTurnCompletedEvent) => void;
  onTurnFailed?: (event: KodaXTurnFailedEvent) => void;
  /** `maxIter` is the active Runner invocation's fuse, not a task-wide budget. */
  onIterationStart?: (iter: number, maxIter: number, meta?: KodaXActivityEventMeta) => void;
  /** Called after each iteration with current token count for UI updates */
  onIterationEnd?: (info: {
    iter: number;
    /** Active Runner invocation fuse; zero is reserved for unbounded callers. */
    maxIter: number;
    tokenCount: number;
    tokenSource: 'api' | 'estimate';
    usage?: KodaXTokenUsage;
    contextTokenSnapshot?: KodaXContextTokenSnapshot;
    /**
     * FEATURE_072: identifies whether this event originates from the parent
     * REPL's agent loop or from a worker (Scout / role worker / evaluator)
     * spawned by the task engine. The REPL uses this to avoid mutating the
     * parent's `contextTokenSnapshot` with worker-derived values — workers
     * still fire `onIterationEnd` for live-token-count UX, but they must not
     * overwrite the parent's context state. Absence is treated as 'parent'
     * for backward compatibility.
     */
    scope?: 'parent' | 'worker';
  } & Partial<KodaXLiveEventMeta>) => void;
  onCompactStart?: (meta?: KodaXActivityEventMeta) => void;
  /** Emitted when compaction finishes and actually changed the context */
  onCompact?: (estimatedTokens: number, meta?: KodaXActivityEventMeta) => void;
  /** Emitted when compaction changes the context so UI can refresh token usage immediately */
  onCompactStats?: (info: { tokensBefore: number; tokensAfter: number } & Partial<KodaXLiveEventMeta>) => void;
  /** Emitted with the rewritten message history when automatic compaction changes the context. */
  onCompactedMessages?: (
    messages: KodaXMessage[],
    update?: CompactionUpdate,
    meta?: KodaXActivityEventMeta,
  ) => void | Promise<void>;
  /** Canonical, post-commit compaction fact. Legacy callbacks are projections. */
  onContextCompactionFinished?: (
    event: KodaXContextCompactionFinishedEvent,
  ) => void;
  /** Ends a started compaction attempt; the optional result preserves legacy one-argument handlers. */
  onCompactEnd?: (
    meta?: KodaXActivityEventMeta,
    result?: KodaXCompactionEndResult,
  ) => void;
  /** Whether the caller has queued follow-up input waiting for the next round */
  hasPendingInputs?: () => boolean;
  /**
   * FEATURE_164 (v0.7.41) — mid-turn user message injection.
   *
   * Fired by the Runner-driven path's `beforeNextTurn` hook AFTER it
   * drains queued user prompts (mode:'prompt') from the canonical
   * MessageQueue and splices them into the transcript before the next
   * LLM call. Replaces the legacy v0.7.26 "mid-iteration yield" path
   * that returned an empty `{text:'', toolCalls:[]}` to force the round
   * to terminate — that path polluted the transcript with an empty
   * assistant turn and confused the model when the next round picked
   * up the same prompts.
   *
   * REPL implementations use this hook to render the injected
   * prompts as user-role history items immediately, so the user sees
   * their typed query as part of the conversation without waiting for
   * the round to end. SDK consumers that don't care about UI visibility
   * can omit this hook — the messages still reach the LLM via the
   * transcript injection.
   *
   * Fires once per Runner iteration boundary, with the array of
   * prompt contents in queue order. Empty arrays are not surfaced.
   */
  onMidTurnUserMessages?: (contents: readonly string[], meta?: KodaXActivityEventMeta) => void;
  onRetry?: (
    reason: string,
    attempt: number,
    maxAttempts: number,
    meta?: KodaXActivityEventMeta,
  ) => void;
  onProviderRateLimit?: (
    attempt: number,
    maxRetries: number,
    delayMs: number,
    meta?: KodaXActivityEventMeta,
  ) => void;
  /**
   * FEATURE_130 (v0.7.36) — structured retry-after notification.
   *
   * Fires whenever a provider's `withRateLimit` loop catches a 429 /
   * 503 / 529 (overloaded) response and decides to wait before
   * retrying. Supersedes the legacy `onProviderRateLimit` (kept for
   * back-compat) by carrying the parsed source of the wait duration —   * UI layers (InkREPL spinner, cost tracker) can surface the
   * difference between "provider told us to wait 45s" and "no header,
   * we're guessing 4s exp-backoff".
   *
   * Pattern B (FEATURE_119) interaction: each in-flight child agent
   * fires its own `onRetryAfter` independently. Multiple children
   * sharing a quota (e.g. 5 coding-plan providers under one tier)
   * surface concurrent waits — the UI deduplicates by provider, not
   * by call site.
   */
  onRetryAfter?: (
    payload: {
      provider: string;
      waitMs: number;
      reason: 'rate-limit' | 'overloaded';
      source:
        | 'retry-after-seconds'
        | 'retry-after-date'
        | 'retry-after-ms'
        | 'exponential-backoff';
      attempt: number;
      maxAttempts: number;
    },
    meta?: KodaXActivityEventMeta,
  ) => void;
  /**
   * Passive capability learning: fired when a provider HARD-rejects a
   * reasoning-effort value. Hosts can record it via the agent-layer capability
   * cache so the rung is narrowed out of the ladder and never offered/sent
   * again.
   */
  onReasoningEffortRejected?: (event: {
    provider: string;
    model: string;
    effort: string;
  } & Partial<KodaXLiveEventMeta>) => void;
  onRepoIntelligenceTrace?: (event: KodaXRepoIntelligenceTraceEvent & Partial<KodaXLiveEventMeta>) => void;
  /** Optional bounded context diagnostics. Emitted only when context.contextDiagnostics is true. */
  onContextBudgetSnapshot?: (
    event: RuntimeContextBudgetSnapshot & Partial<KodaXLiveEventMeta>,
  ) => void;
  /**
   * Hash-only prompt-cache diagnostics; never contains prompt or message text.
   * Emitted only when context.contextDiagnostics is true.
   */
  onPromptCacheDiagnostics?: (
    event: KodaXPromptCacheDiagnosticEvent & Partial<KodaXLiveEventMeta>,
  ) => void;
  /** Optional bounded tool-exposure diagnostics. Emitted only when context.contextDiagnostics is true. */
  onToolExposurePlanned?: (
    event: RuntimeToolExposurePlan & Partial<KodaXLiveEventMeta>,
  ) => void;
  /** Bounded operational reason whenever a compaction gate skips work. */
  onContextCompactionSkipped?: (
    event: RuntimeCompactionSkippedEvent & Partial<KodaXLiveEventMeta>,
  ) => void;
  /**
   * Fired when the Sidecar Verifier produces an actionable message.
   *
   * `revise` is usually injected back into the main agent as a synthetic user
   * message; if the reanimate budget is already exhausted, the same verdict is
   * surfaced with `delivery: "budget-exhausted"` and no injection occurs.
   * `blocked` is surfaced terminally to the user. Accept remains silent here
   * because there is no sidecar-to-agent reply to show.
   */
  onSidecarMessage?: (event: KodaXSidecarMessageEvent & Partial<KodaXLiveEventMeta>) => void;
  /**
   * FEATURE_097 (v0.7.34): emitted whenever the Scout-seeded todo list
   * changes — initial seed at `emit_scout_verdict`, per-item updates from
   * `todo_update` tool calls, and Evaluator-verdict auto-handling
   * (accept/revise/replan). Single-rail (no `KodaXManagedTaskStatusEvent`
   * snapshot fallback): KodaX is a single-process CLI, all consumers live
   * in one event loop, so subscriber lag is not a real failure mode
   * (FEATURE_086 onRepoIntelligenceTrace single-rail precedent).
   */
  onTodoUpdate?: (items: TodoList, meta?: KodaXActivityEventMeta) => void;
  /**
   * Warn-only telemetry: a successful real work tool completed while the
   * visible todo list had pending items but no item marked in_progress.
   * The runner does not mutate the todo list for this signal; it only
   * nudges the next model turn to call todo_update explicitly.
   */
  onTodoDriftWarning?: (event: KodaXTodoDriftWarningEvent & Partial<KodaXLiveEventMeta>) => void;
  /** Structured provider recovery event (Feature 045) */
  onProviderRecovery?: (
    event: ProviderRecoveryEvent,
    meta?: KodaXActivityEventMeta,
  ) => void;
  /** Post-finalization notification. Observer failures cannot rewrite the terminal result. */
  onComplete?: (meta?: KodaXActivityEventMeta) => void;
  onError?: (error: Error, meta?: KodaXActivityEventMeta) => void;
  onManagedTaskStatus?: (status: KodaXManagedTaskStatusEvent & Partial<KodaXLiveEventMeta>) => void;
  /**
   * FEATURE_247 (R4) — fired once at managed-task start with the effective
   * profile / tool scope / verification snapshot. Lets an SDK embedder confirm
   * the intended profile (e.g. Partner) actually entered the SDK managed task
   * and diagnose the tools + verification constraints it was given.
   */
  onEffectiveConfig?: (config: KodaXEffectiveTaskConfig & Partial<KodaXLiveEventMeta>) => void;
  /** FEATURE_229: workflow process snapshot stream for SDK/host panels. */
  onWorkflowProcessEvent?: (event: WorkflowProcessEvent & Partial<KodaXLiveEventMeta>) => void;
  /**
   * ADR-049: per-agent digest stream for the inline `run_workflow` path. Fires
   * once per workflow child agent reaching a terminal/summary state
   * (`agent_completed` / `agent_unverified` / `agent_failed` /
   * `agent_summary_updated`). The REPL formats each via `formatWorkflowAgentDigest`
   * and writes it to the transcript — matching the slash `/workflow` path and
   * Actor children, whose summaries persist in scrollback.
   */
  onWorkflowAgentDigest?: (event: KodaXWorkflowAgentDigestEvent & Partial<KodaXLiveEventMeta>) => void;
  /**
   * Fired when Scout's managed-task completion is inferred but the harness
   * detected suspicious signals (mutation expected but none happened, budget
   * exhausted, tool calls followed by text-only exit without explicit
   * completion, etc.). The task still completes — this is an observability
   * signal, not a retry trigger. UI layers can surface a warning so users
   * know to verify the result.
   */
  onScoutSuspiciousCompletion?: (payload: {
    confidence: 'uncertain';
    signals: KodaXScoutSuspiciousSignal[];
    sessionId?: string;
    lastTextPreview: string;
  } & Partial<KodaXLiveEventMeta>) => void;
  /**
   * FEATURE_167 (v0.7.41) — Evaluator terminal-verdict fallback.
   *
   * Fires when the runner-driven outer loop detects that the Evaluator
   * exited a turn without `emit_verdict` AND the B1 retry exhausted its
   * cap. The runner THEN writes a synthesized terminal verdict into
   * `recorder.verdict` (B2) and fires this event so SDK consumers
   * (REPL status line, telemetry sinks, dashboards) can surface the
   * fallback rather than mistake it for a real `accept`. The verdict
   * carries a stable `reason` so post-hoc filtering can isolate
   * synthesized terminations.
   *
   * Fires AFTER `recorder.verdict` is committed but BEFORE
   * `formatDeterministicEvaluatorResult` builds the final `KodaXResult`
   * — consumers see the synth signal in causal order before the result
   * surfaces.
   */
  /** Returns a formatted cost report for the current session. Set by agent at session start. */
  getCostReport?: { current: (() => string) | null };

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (
    tool: string,
    input: Record<string, unknown>,
    meta?: KodaXToolEventMeta
  ) => Promise<boolean | string>;
  /** Ask user a question interactively - Issue 069. Select answers may be
   *  strings, arrays, or structured custom-input answers. */
  askUser?: (
    options: AskUserQuestionOptions,
    meta?: KodaXToolEventMeta,
    context?: KodaXUserInputPromptContext,
  ) => Promise<AskUserAnswer>;
  /** Ask user multiple independent questions sequentially - 澶氶棶棰橀『搴忔彁闂?*/
  askUserMulti?: (
    options: AskUserMultiOptions,
    meta?: KodaXToolEventMeta,
    context?: KodaXUserInputPromptContext,
  ) => Promise<Record<string, AskUserAnswer> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (
    options: { question: string; default?: string },
    meta?: KodaXToolEventMeta,
    context?: KodaXUserInputPromptContext,
  ) => Promise<string | undefined>;
  /**
   * FEATURE_074: Exit plan mode with user approval. Called by the `exit_plan_mode` tool.
   * Returns:
   *   - `true` when the user approved the plan (mode flipped to accept-edits).
   *   - `false` when the user rejected the plan (mode stays plan).
   *   - `'not-in-plan-mode'` when the session is not currently in plan mode, so
   *     the tool is being called out-of-context. The tool turns this into an
   *     explicit error instead of a silent no-op.
   */
  exitPlanMode?: (plan: string) => Promise<boolean | 'not-in-plan-mode'>;
  /** Semantic memory review plan produced from explicit user feedback. */
  onMemoryReview?: (plan: MemoryReviewPlan) => void;
  onMemoryNotice?: (notice: {
    readonly sessionId?: string;
    readonly episodeId: string;
    readonly summaries: readonly string[];
    readonly proposalIds: readonly string[];
  }) => void;
  onMemoryOutcomeDigest?: (
    digest: KodaXMemoryOutcomeDigest,
    metadata?: { readonly jobId?: string },
  ) => void;
  onMemoryReviewReceipt?: (receipt: {
    readonly sessionId?: string;
    readonly jobId?: string;
    readonly reviewKey: string;
    readonly proposalIds: readonly string[];
    readonly completedAt: string;
  }) => void;
}


// ============== Provider Recovery Event (Feature 045) ==============

/**
 * Structured event emitted during provider recovery.
 * Provides fine-grained information about the failure, recovery strategy,
 * and current state of the retry ladder.
 */
export interface ProviderRecoveryEvent {
  /** The failure stage when the error occurred. */
  stage: FailureStage;
  /** The classified error class. */
  errorClass: ResilienceErrorClass;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Maximum automatic retry attempts. */
  maxAttempts: number;
  /** Delay before next attempt (ms). */
  delayMs: number;
  /** The recovery action being taken. */
  recoveryAction: RecoveryAction;
  /** Step in the recovery ladder (1-4). */
  ladderStep: RecoveryLadderStep;
  /** Whether non-streaming fallback has been used. */
  fallbackUsed: boolean;
  /** Server-provided Retry-After value (ms), if available. */
  serverRetryAfterMs?: number;
}

// ============== Agent 选项 ==============

export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  autoResume?: boolean;
  scope?: KodaXSessionScope;
  /** Consumer-owned private string persisted with the session. */
  tag?: string;
  storage?: KodaXSessionStorage;
  initialMessages?: KodaXMessage[];
  /** Host-provided extension state paired with initialMessages, avoiding a full storage load. */
  initialExtensionState?: KodaXExtensionSessionState;
  /** Host-provided extension records paired with initialMessages, avoiding a full storage load. */
  initialExtensionRecords?: KodaXExtensionSessionRecord[];
  /**
   * Persistence ownership signal (FEATURE_173 dual-writer fix).
   *
   * When `true`, a higher-level host (the interactive REPL) owns writing
   * this session to `storage` — it persists the full lineage / uiHistory /
   * artifactLedger incrementally via `appendSessionDelta`. The runner MUST
   * NOT also snapshot the session: `saveSessionSnapshot` early-returns so
   * the runner's flat full-rewrite `storage.save` can never race / clobber
   * the host's richer incremental writes (which regressed `activeEntryId`
   * to the first round on resume). Context-silent protocol facts may use the
   * host's optional atomic `storage.mutateLineage`; this never writes a stale
   * full session snapshot. A host using F263 durable Memory review facts must
   * provide that capability; those writes fail closed when it is absent.
   *
   * `storage` is still consulted for LOAD (resume / `resolveInitialMessages`
   * tier 2). When absent (print CLI, ACP, SDK headless), the runner remains
   * the sole writer — unchanged behaviour, fail-safe default.
   */
  persistedByHost?: boolean;
}

export interface KodaXContextTokenSnapshot {
  /** Current best-known token count for the full conversation context. */
  currentTokens: number;
  /** Local estimate for the same message set, used to adjust later message deltas. */
  baselineEstimatedTokens: number;
  /** Whether the snapshot is based on provider/API usage or local estimation. */
  source: 'api' | 'estimate';
  /** Optional turn usage from the latest provider response. */
  usage?: KodaXTokenUsage;
}

export interface KodaXProviderPolicyHints {
  longRunning?: boolean;
  harnessProfile?: KodaXHarnessProfile;
  evidenceHeavy?: boolean;
  multimodal?: boolean;
  capabilityRuntime?: boolean;
  mcpRequired?: boolean;
  brainstorm?: boolean;
  workIntent?: KodaXTaskWorkIntent;
}

// FEATURE_082 / FEATURE_200 Phase F: MCP types live in @kodax-ai/agent; KodaX
// aliases extracted to ./types/mcp.ts and re-exported for backward compat.
export * from './types/mcp.js';


// ============== Todo Plan Surface (FEATURE_097, v0.7.34) ==============

import type { TodoList } from './types/todo.js';
export * from './types/todo.js';

export interface KodaXRepoRoutingSignals {
  workspaceRoot?: string;
  changedFileCount: number;
  changedLineCount: number;
  addedLineCount: number;
  deletedLineCount: number;
  touchedModuleCount: number;
  changedModules: string[];
  crossModule: boolean;
  reviewScale?: KodaXReviewScale;
  riskHints: string[];
  activeModuleId?: string;
  activeModuleConfidence?: number;
  activeImpactConfidence?: number;
  impactedModuleCount?: number;
  impactedSymbolCount?: number;
  predominantCapabilityTier?: 'high' | 'medium' | 'low';
  suggestedComplexity?: KodaXTaskComplexity;
  plannerBias: boolean;
  investigationBias: boolean;
  lowConfidence: boolean;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXTaskCapabilityHint {
  kind: 'skill' | 'tool' | 'command' | 'workflow';
  name: string;
  details?: string;
}

export interface KodaXTaskVerificationCriterion {
  id: string;
  label: string;
  description: string;
  threshold: number;
  weight: number;
  requiredEvidence?: string[];
}

export interface KodaXRuntimeVerificationContract {
  startupCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  readySignal?: string;
  baseUrl?: string;
  uiFlows?: string[];
  apiChecks?: string[];
  dbChecks?: string[];
  fixtures?: string[];
}

export interface KodaXTaskVerificationContract {
  summary?: string;
  instructions?: string[];
  requiredEvidence?: string[];
  requiredChecks?: string[];
  capabilityHints?: KodaXTaskCapabilityHint[];
  rubricFamily?:
    | 'code-review'
    | 'frontend'
    | 'product-completeness'
    | 'functionality'
    | 'code-quality'
    // FEATURE_247: profile-scoped families for non-coding SDK surfaces (e.g.
    // KodaX-Space Partner research). Additive — never selected unless a caller
    // sets it, so default coding verification is unchanged.
    | 'partner-research';
  criteria?: KodaXTaskVerificationCriterion[];
  runtime?: KodaXRuntimeVerificationContract;
}

/**
 * FEATURE_247 — SDK-consumer agent profile identity (e.g. KodaX-Space Partner).
 *
 * The SDK core treats this as OPAQUE attribution: it is echoed onto results,
 * events, the effective-config snapshot, session runtimeInfo, and tool context
 * so an embedder can confirm which profile actually ran and can attribute
 * concurrent Partner/Coder sessions. Absent ⇒ the default Coding Agent, with no
 * behavioral change anywhere.
 *
 * Only two fields carry behavior, both additive and gated on their own presence:
 *   - `instructions` — on the SA path the embedder sets
 *     `context.systemPromptOverride`; the AMA/AMAW path builds role prompts
 *     internally, so when this is set the Worker role prompt PREPENDS this block
 *     (absent ⇒ byte-identical default coding role prompt).
 *   - `verification` — a profile-default verifier standard the Sidecar Verifier
 *     applies; per-task `context.taskVerification` still overrides/augments it.
 *
 * Everything else (`surface`/`id`/`version`/`name`) is pure identity passthrough.
 */
export interface KodaXAgentProfile {
  /** Surface/profile label, e.g. `'code'` | `'partner'`. Opaque to the core. */
  readonly surface?: string;
  /** Stable profile id (UUID or stable name). Opaque to the core. */
  readonly id?: string;
  /** Profile version. Opaque to the core. */
  readonly version?: string;
  /** Human-facing display name. Opaque to the core. */
  readonly name?: string;
  /**
   * Partner behavior instructions injected into the AMA/AMAW Worker role prompt
   * (prepended). The SA path uses `context.systemPromptOverride` instead — this
   * field is the AMA-path equivalent so a Partner profile behaves consistently
   * across both execution modes.
   */
  readonly instructions?: string;
  /**
   * Profile-default verification standard. Merged with per-task
   * `context.taskVerification` (per-task fields win) before reaching the Sidecar
   * Verifier.
   */
  readonly verification?: KodaXTaskVerificationContract;
}

export type KodaXSkillProjectionConfidence = 'high' | 'medium' | 'low';

export interface KodaXSkillInvocationRuntimePolicy {
  readonly enforceAtRuntime?: boolean;
}

export interface KodaXSkillInvocationContext {
  name: string;
  path: string;
  description?: string;
  arguments?: string;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hookEvents?: string[];
  /** Marker requesting trusted policy rehydration inside daemon/worker transports. */
  runtimePolicy?: KodaXSkillInvocationRuntimePolicy;
  expandedContent: string;
}

export interface KodaXSkillMap {
  skillSummary: string;
  executionObligations: string[];
  verificationObligations: string[];
  requiredEvidence: string[];
  ambiguities: string[];
  projectionConfidence: KodaXSkillProjectionConfidence;
  rawSkillFallbackAllowed: boolean;
  allowedTools?: string;
  preferredAgent?: string;
  preferredModel?: string;
  invocationContext?: 'fork';
  hookEvents?: string[];
}

export interface KodaXTaskToolPolicy {
  summary: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedShellPatterns?: string[];
  allowedWritePathPatterns?: string[];
}

export interface KodaXChildContextBundle {
  id: string;
  fanoutClass: KodaXChildFanoutClass;
  objective: string;
  scopeSummary?: string;
  evidenceRefs: string[];
  constraints: string[];
  readOnly: boolean;
  /**
   * FEATURE_102 / FEATURE_259 — semantic model tier intent. The runtime maps
   * configured `fast`/`deep` tiers to concrete routes and safely inherits the
   * parent when a tier is unavailable or ineligible.
   */
  modelHint?: KodaXChildModelHint;
  /**
   * FEATURE_217 (v0.7.49): workflow-level child isolation hint. Default is
   * shared parent cwd; `worktree` is opt-in and parent-managed.
   */
  isolation?: WorkflowIsolation;
  /**
   * FEATURE_191 — optional registered specialist agent name. When set,
   * the child is dispatched with that agent's `instructions` /
   * `tools` / `reasoning` / `guardrails` instead of the stock Worker
   * bundle. Resolved via `resolveConstructedAgent(name)` at dispatch
   * time; unknown names are rejected by `toolDispatchChildTask` with
   * a tool-result error (not throw) before the bundle reaches
   * `executeReadChild` / `executeWriteChild`. Optional — omitting
   * preserves byte-identical v0.7.42 baseline dispatch behavior.
   */
  specialistName?: string;
  /**
   * FEATURE_102 Phase 2 (v0.7.45) — explicit per-dispatch provider/model the
   * dispatching agent chose for this child (e.g. a cross-family second review).
   * Priority in child-executor: `bundle.provider/model` > specialist's declared
   * model > parent default. Omitting both inherits the parent (byte-identical).
   */
  provider?: string;
  model?: string;
  /** Optional per-dispatch reasoning effort. Omit to inherit the parent effort. */
  effort?: KodaXWireReasoningEffort;
  /**
   * FEATURE_246 Part B — optional JSON Schema (opaque) for the child's
   * structured output. When set, the child briefing asks for a fenced JSON
   * block matching it; the child executor parses + validates the result (with
   * one bounded repair turn) and surfaces it on `KodaXChildAgentResult.structured`.
   */
  outputSchema?: unknown;
  /**
   * Runtime-only fixed AMA result contract. Unlike Workflow outputSchema,
   * invalid output is parse-only and never starts a repair model turn.
   */
  structuredOutputContract?: 'pattern-disposition-parse-only';
  /** Trusted host provenance plus the generated script's terse-result declaration. */
  workflowOutputContract?: {
    readonly kodaxAuthored: boolean;
    readonly terseResult: boolean;
  };
}

/**
 * FEATURE_120 v0.7.39 Phase 4 — model tier hint. Tier semantics:
 *   - `'fast'` — short lookups (read 1-2 files, simple grep).
 *   - `'balanced'` — normal subtasks (default behavior; same as omit).
 *   - `'deep'` — heavy reasoning (multi-file analysis, complex audit).
 *
 * `omit` ≡ `'balanced'` so the absent case maps to "default routing".
 * Validators MUST reject other strings (the dispatch tool drops
 * unknown values silently with a tolerant fallback to `undefined`).
 */
export type KodaXChildModelHint = 'fast' | 'balanced' | 'deep';

export type KodaXChildTierOutcome =
  | 'applied'
  | 'balanced-parent'
  | 'fast-write-ineligible'
  | 'unconfigured'
  | 'shadowed-by-selector'
  | 'inherited';

export type KodaXChildRouteSource = 'explicit' | 'specialist' | 'tier' | 'parent' | 'default';

export interface KodaXChildRouteFacts {
  readonly requestedTier: KodaXChildModelHint | 'inherited';
  readonly tierOutcome: KodaXChildTierOutcome;
  readonly providerSource: KodaXChildRouteSource;
  readonly modelSource?: Exclude<KodaXChildRouteSource, 'default'>;
  readonly initialProvider?: string;
  readonly initialModel?: string;
  readonly finalProvider?: string;
  readonly finalModel?: string;
  readonly resolvedEffort?: string;
  readonly fallbackReason?: string;
  readonly iterations?: number;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly outputTokens?: number;
  readonly digestTokens?: number;
  readonly durationMs?: number;
}

export interface KodaXChildAgentResult {
  childId: string;
  fanoutClass: KodaXChildFanoutClass;
  status: 'completed' | 'blocked' | 'failed';
  disposition: 'candidate' | 'valid' | 'false-positive' | 'needs-more-evidence';
  summary: string;
  evidenceRefs: string[];
  contradictions: string[];
  artifactPaths?: string[];
  sessionId?: string;
  /** Bounded workflow transcript digest. Full `summary` remains the synthesis/audit source. */
  digest?: string;
  /** True when a workflow child digest was attempted but failed (error/timeout/empty distillation). */
  digestFailed?: boolean;
  /** True when a workflow child digest is running asynchronously and may arrive later. */
  digestPending?: boolean;
  /** Actual provider/model selected for this child run, when known. */
  provider?: string;
  model?: string;
  /** Actual iterations consumed by this child agent. */
  actualIterations?: number;
  /** Best-known token usage for this child run. Used by workflow budget accounting. */
  totalTokensUsed?: number;
  /** Token usage attributable only to the optional presentation digest call. */
  digestTokensUsed?: number;
  /** Provider-reported usage for the optional digest call (diagnostic subset of totalTokensUsed). */
  digestUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
  };
  /** Correlated model-tier and fallback facts for cost/quality reporting. */
  routeFacts?: KodaXChildRouteFacts;
  /** True when the child exhausted its iteration budget before completing. */
  limitReached?: boolean;
  /**
   * True when the child's `runKodaX` exited via CAP-083 AbortError silent
   * terminal (`KodaXResult.interrupted === true`). Surfaces the
   * "success but empty lastText" path that produces empty
   * `<task-completed task_id="X"></task-completed>` banners.
   * Diagnostic field — populated by child-executor on the success branch
   * and consumed by dispatch-child-tasks' empty-summary fallback.
   */
  interrupted?: boolean;
  /**
   * FEATURE_246 Part B — schema-validated structured output parsed from the
   * child's final text (present only when the bundle carried `outputSchema`
   * and a JSON value was parseable). Surfaced to the workflow runtime as
   * `WorkflowTaskResult.structured`.
   */
  structured?: unknown;
}

export interface KodaXParentReductionContract {
  owner: 'parent';
  strategy: 'direct-parent' | 'evaluator-assisted' | 'reducer-child';
  collapseChildTranscripts: boolean;
  summary: string;
  requiredArtifacts: string[];
}

export interface KodaXChildExecutionResult {
  readonly results: readonly KodaXChildAgentResult[];
  readonly mergedFindings: readonly KodaXChildFinding[];
  readonly mergedArtifacts: readonly string[];
  readonly totalTokensUsed: number;
  readonly cancelledChildren: readonly string[];
}

export interface KodaXChildFinding {
  readonly childId: string;
  readonly objective: string;
  readonly evidence: readonly string[];
  readonly artifacts: readonly string[];
}

export type KodaXAgentMode =
  | 'ama'
  | 'sa'
  /** @deprecated AMAW was merged into AMA in v0.7.72; accepted as an input alias only. */
  | 'amaw';
export type KodaXCanonicalAgentMode = Exclude<KodaXAgentMode, 'amaw'>;

/** Normalize the retired AMAW spelling at every public SDK entry boundary. */
export function normalizeKodaXAgentMode(mode: KodaXAgentMode): KodaXCanonicalAgentMode;
export function normalizeKodaXAgentMode(mode: undefined): undefined;
export function normalizeKodaXAgentMode(
  mode: KodaXAgentMode | undefined,
): KodaXCanonicalAgentMode | undefined;
export function normalizeKodaXAgentMode(
  mode: KodaXAgentMode | undefined,
): KodaXCanonicalAgentMode | undefined {
  return mode === 'amaw' ? 'ama' : mode;
}
export type KodaXMemoryStrategy = 'continuous' | 'compact' | 'reset-handoff';
export type KodaXBudgetDisclosureZone = 'green' | 'yellow' | 'orange' | 'red';

export interface KodaXManagedTaskHarnessTransition {
  from: KodaXHarnessProfile;
  to: KodaXHarnessProfile;
  round: number;
  source: 'scout' | 'evaluator';
  reason?: string;
  approved: boolean;
  denialReason?: string;
}

export type KodaXManagedTaskPhase =
  | 'starting'
  | 'routing'
  | 'preflight'
  | 'round'
  | 'worker'
  | 'upgrade'
  | 'verifying'
  | 'completed';

export type KodaXManagedLiveEventPresentation =
  | 'status'
  | 'assistant'
  | 'thinking';

export interface KodaXManagedLiveEvent {
  key: string;
  kind: 'progress' | 'completed' | 'notification' | 'warning';
  presentation?: KodaXManagedLiveEventPresentation;
  phase?: KodaXManagedTaskPhase;
  workerId?: string;
  workerTitle?: string;
  summary: string;
  detail?: string;
  persistToHistory?: boolean;
}

export interface KodaXManagedTaskStatusEvent {
  agentMode: KodaXAgentMode;
  harnessProfile: KodaXHarnessProfile;
  /**
   * FEATURE_247 — SDK-consumer agent profile driving this managed task, echoed
   * from `options.context.agentProfile`. Absent ⇒ default Coding Agent.
   */
  agentProfile?: KodaXAgentProfile;
  activeWorkerId?: string;
  activeWorkerTitle?: string;
  childFanoutClass?: KodaXChildFanoutClass;
  childFanoutCount?: number;
  currentRound?: number;
  maxRounds?: number;
  phase?: KodaXManagedTaskPhase;
  note?: string;
  detailNote?: string;
  events?: KodaXManagedLiveEvent[];
  persistToHistory?: boolean;
  upgradeCeiling?: KodaXHarnessProfile;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /**
   * v0.7.38 FEATURE_156 — true while the runner-driven outer loop is
   * parked in `waitForWakeEvent` (idle-yield from FEATURE_155). The
   * agent is alive but suspended pending an external wake — typically
   * a dispatched child task completing, or a user message arriving via
   * the FEATURE_115 MessageQueue (chat-while-waiting).
   *
   * Default (`undefined` / `false`) means "not idle-waiting" — every
   * pre-FEATURE_156 emit site implicitly sets this. Consumers MUST
   * branch on `=== true` (not truthy / not undefined) so that
   * subsequent role-emits with `idleWaiting` unset naturally transition
   * the UI out of the waiting state.
   *
   * Agent-agnostic: today only the Worker can reach an idle-yield
   * state (the dispatch tool is restricted to Scout/Generator/Worker,
   * and the `hasEmittedHandoff` gate blocks idle-yield post-handoff so
   * Evaluator can never park here), but the field carries no
   * role-specific semantics — `activeWorkerTitle` carries the role
   * identity for display.
   */
  idleWaiting?: boolean;
  /**
   * v0.7.38 FEATURE_156 — count of children the agent is actively
   * waiting on at the idle-yield boundary (`registry.size` snapshot).
   * Status-bar renders this as "waiting for N children" so the user
   * can tell how many outstanding pieces of work are pending. 0 with
   * `idleWaiting=true` is the transitional "background banner queued,
   * registry already drained" state (fast-child race recovery path,
   * see FEATURE_155 hotfix follow-up #2) and renders as "idle —   * resuming".
   */
  idleWaitingPendingCount?: number;
}

/**
 * FEATURE_247 (R4) — effective managed-task configuration snapshot, emitted once
 * at run start via {@link KodaXEvents.onEffectiveConfig} so an SDK embedder can
 * (a) assert the intended profile actually entered the SDK managed task and
 * (b) diagnose which tools + verification standard are in force.
 */
export interface KodaXEffectiveTaskConfig {
  readonly agentMode: KodaXAgentMode;
  /** SDK-consumer profile driving the run; undefined ⇒ default Coding Agent. */
  readonly agentProfile?: KodaXAgentProfile;
  /** Tool names visible to the model for this run. */
  readonly toolScope: readonly string[];
  /**
   * Effective verification standard reaching the Sidecar Verifier — the profile
   * default merged with per-task `context.taskVerification` (per-task wins).
   */
  readonly verification?: KodaXTaskVerificationContract;
  /** Resolved Sidecar Verifier provider/model, when the verifier is active. */
  readonly verifier?: { readonly provider?: string; readonly model?: string };
}

export interface KodaXVerificationScorecardCriterion {
  id: string;
  label: string;
  threshold: number;
  score: number;
  passed: boolean;
  weight: number;
  requiredEvidence?: string[];
  evidence?: string[];
  reason?: string;
}

export interface KodaXVerificationScorecard {
  rubricFamily?: KodaXTaskVerificationContract['rubricFamily'];
  overallScore: number;
  verdict: 'accept' | 'revise' | 'blocked';
  criteria: KodaXVerificationScorecardCriterion[];
  trend?: 'improving' | 'flat' | 'regressing';
  summary?: string;
}

export interface KodaXRoleRoundSummary {
  role: KodaXTaskRole;
  round: number;
  objective: string;
  confirmedConclusions: string[];
  unresolvedQuestions: string[];
  nextFocus: string[];
  summary: string;
  sourceWorkerId?: string;
  updatedAt: string;
}

export interface KodaXBudgetExtensionRequest {
  requestedIters: 1 | 2 | 3;
  reason: string;
  completionExpectation: string;
  confidenceToFinish: number;
  fallbackIfDenied: string;
}

export interface KodaXManagedBudgetSnapshot {
  totalBudget: number;
  reserveBudget: number;
  reserveRemaining: number;
  upgradeReserveBudget?: number;
  upgradeReserveRemaining?: number;
  plannedRounds: number;
  currentRound: number;
  spentBudget: number;
  remainingBudget: number;
  workerId?: string;
  role?: KodaXTaskRole;
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  zone?: KodaXBudgetDisclosureZone;
  showExactRoundCounter?: boolean;
  allowExtensionRequest?: boolean;
  mustConverge?: boolean;
  softMaxIter?: number;
  hardMaxIter?: number;
  extensionGrantedIters?: number;
  extensionDenied?: boolean;
  extensionReason?: string;
}

/** Mutable tracker for filesystem/shell mutations observed during managed Worker execution. */
export interface ManagedMutationTracker {
  readonly files: Map<string, number>;
  totalOps: number;
  /**
   * Count of high-risk shell mutations (git push/commit/rm, npm install/publish,
   * rm/mv/cp, etc.) the Worker ran via `bash`. Tracked separately from `totalOps`
   * because bash writes are a blind spot — we cannot know which file / how many
   * lines a shell command touched — so the Verifier gate fires conservatively on
   * any risky shell op rather than inferring risk back out of `totalOps`.
   * Optional: defaults to 0 when absent (read as `riskyShellOps ?? 0`).
   */
  riskyShellOps?: number;
  /**
   * Count of filesystem mutations whose touched file could NOT be attributed
   * from the tool input (the path is computed inside the handler): `undo`,
   * `worktree_create` / `worktree_remove`, `stage_construction` /
   * `stage_agent_construction`, or `stage_self_modify`. These bump `totalOps`
   * but leave `files` empty,
   * so without a separate count they would look like trivial no-op work to the
   * Verifier gate. Like `riskyShellOps`, an unattributable write is a blind spot
   * the gate fires on conservatively. Optional: read as `unattributedWriteOps ?? 0`.
   */
  unattributedWriteOps?: number;
  /** Set to true after scope reflection has been injected once. Prevents repeated injection. */
  reflectionInjected?: boolean;
}

/**
 * FEATURE_247 (R2) — a minimal, stable per-tool view handed to a
 * {@link KodaXToolVisibilityPolicy}. Only the load-bearing declarative metadata
 * is exposed (never the handler / full schema) so the contract stays stable as
 * tools evolve. `sideEffect` distinguishes readonly / reads-network /
 * mutates-* classes; `planModeAllowed` marks query-shaped tools.
 */
export interface KodaXToolVisibilityMeta {
  readonly name: string;
  readonly sideEffect: ToolSideEffect;
  readonly planModeAllowed: boolean;
}

/**
 * FEATURE_247 (R2) — an SDK-consumer predicate evaluated for every candidate
 * tool BEFORE the model-visible tool list is built. Return `false` to hide a
 * tool from the model. Space uses this to express profile-scoped rules such as
 * "only readonly + reads-network visible" and to default-deny anything it does
 * not explicitly recognize, without enumerating a name list that drifts as the
 * SDK adds tools. Covers SDK builtin + host-registered + extension + MCP tools
 * uniformly (each carries a required `sideEffect`). A tool with no resolvable
 * metadata is hidden (fail-closed).
 */
export type KodaXToolVisibilityPolicy = (tool: KodaXToolVisibilityMeta) => boolean;

export interface KodaXSkillScriptInputFile {
  /** Workspace-relative source path copied into the isolated staging directory. */
  readonly path: string;
  /** Optional staging-relative name; defaults to the source basename. */
  readonly as?: string;
}

export interface KodaXSkillScriptOutputFile {
  /** Staging-relative path produced by the script. */
  readonly path: string;
  /** Workspace-relative destination populated after a successful run. */
  readonly target: string;
}

export interface KodaXSkillScriptRunInput {
  readonly skill: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly inputs: readonly KodaXSkillScriptInputFile[];
  readonly outputs: readonly KodaXSkillScriptOutputFile[];
}

/** Run-scoped, fail-closed broker used by the remote-only Skill script tool. */
export interface KodaXSkillScriptRunner {
  run(input: KodaXSkillScriptRunInput, context: {
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  dispose(): Promise<void>;
}

/** Trusted coding host bridge; lifecycle state remains owned by the Agent controller. */
export interface KodaXActorHost {
  createWorkflowOwner(parentPath: string, runId: string): Promise<AgentActorClient>;
  workflowOwnerSignal(ownerPath: string): AbortSignal;
  settleWorkflowOwner(
    ownerPath: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: AgentExecutionResult & { readonly error?: string },
  ): Promise<void>;
  bindActor(actorPath: string): AgentActorClient;
  closeActor(targetPath: string, reason?: string): Promise<void>;
  registerTurnExecutor(key: string, executor: AgentTurnExecutor): () => void;
  waitForAgentCapacity(signal?: AbortSignal): Promise<boolean>;
}

export interface KodaXManagedWorkBudget {
  totalBudget: number;
  spentBudget: number;
  currentHarness: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  lastApprovalBudgetTotal?: number;
}

export type KodaXShellKind =
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'bash'
  | 'zsh';

export type KodaXShellProfileMode =
  | 'default'
  | 'none'
  | 'login'
  | 'interactive'
  | 'login-interactive';

/**
 * Host-owned, JSON-serializable shell execution policy.
 *
 * The contract is opt-in. When absent, command execution keeps the legacy
 * platform-shell/process.env behavior. When present, KodaX resolves a
 * credential-filtered environment through this shell in the effective cwd,
 * then executes the command with the same explicit interpreter.
 */
export interface KodaXShellExecutionContract {
  readonly version: 1;
  readonly shell: {
    readonly kind: KodaXShellKind;
    /** Absolute path is recommended; a bare name is resolved from sanitized PATH. */
    readonly executable?: string;
    /** Trusted fixed arguments inserted before KodaX's generated command flag. */
    readonly args?: readonly string[];
    readonly profile?: KodaXShellProfileMode;
  };
  readonly environment?: {
    /** `filtered` keeps non-sensitive daemon variables; `none` keeps only OS bootstrap variables. */
    readonly inherit?: 'filtered' | 'none';
    /** Trusted, non-secret variables added before profile resolution. */
    readonly set?: Readonly<Record<string, string>>;
    /** Additional glob-style variable-name denies. Built-in credential denies are immutable. */
    readonly denyPatterns?: readonly string[];
    /**
     * Trusted shell code run after profile loading and before environment
     * capture. Directory-aware version-manager activation belongs here.
     */
    readonly setup?: string;
    /** Windows-only PATH source. `registry` re-reads current Machine/User PATH. */
    readonly windowsPath?: 'process' | 'registry';
  };
  readonly cache?: {
    /** Strict environment-cache lifetime. Zero disables caching. */
    readonly ttlMs?: number;
    /** Changing this JSON scalar explicitly invalidates an existing cache entry. */
    readonly refreshToken?: string | number;
  };
  readonly probeTimeoutMs?: number;
}

export interface KodaXShellSandboxPrepareInput {
  readonly toolCallId?: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly command: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
  /** Internal callers may forbid the broker's ordinary host fallback. */
  readonly fallbackToNormalExecution?: boolean;
  /** Caller cancellation while waiting for sandbox admission/preparation. */
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline shared with the command timeout. */
  readonly deadlineAt?: number;
  readonly reportObservation?: (observation: KodaXShellSandboxObservation) => void;
}

export interface KodaXPreparedShellSandboxInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
  /** Private bootstrap bytes consumed by the native host before target stdin. */
  readonly stdinPrefix?: Uint8Array;
  /** Broker-only framed output. The requested descriptor is never inherited by the target. */
  readonly controlChannel?: {
    readonly fd: 3;
    readonly maxOutputBytes: number;
  };
  /** The authenticated native runner owns a per-command kill-on-close Job. */
  readonly processTreeContainment?: 'native-job';
  cleanup(input?: {
    readonly execution: 'not_started' | 'started_or_unknown';
    readonly controlOutput?: Uint8Array;
  }): Promise<KodaXShellSandboxObservation | undefined>;
}

/** Runtime-owned OS sandbox broker for selected concrete shell calls. */
export interface KodaXShellSandbox {
  /**
   * Host-trusted proof that the prepared root cannot settle while one of its
   * descendants remains alive. Omitted adapters remain source-compatible but
   * cannot authorize opaque process-launching shell calls.
   */
  readonly processTreeContainment?: 'root-exit-drains';
  prepare(
    input: KodaXShellSandboxPrepareInput,
  ): Promise<KodaXPreparedShellSandboxInvocation | undefined>;
}

/** Canonical snapshot produced by the trusted main-process text authority. */
export interface KodaXTrustedTextFileSnapshot {
  readonly state: 'missing' | 'present';
  readonly content: string;
  readonly revision: string;
  /** Stable canonical namespace slot used by the cross-Runtime kernel lock. */
  readonly slot: string;
  readonly canonicalPath: string;
}

export interface KodaXTrustedTextCommitInput {
  readonly path: string;
  readonly expectedRevision: string;
  readonly content: string;
  readonly createParentDirectories: boolean;
  readonly signal?: AbortSignal;
}

export type KodaXTrustedTextCommitOutcome =
  | {
      readonly status: 'written';
      readonly before: KodaXTrustedTextFileSnapshot;
      readonly after: KodaXTrustedTextFileSnapshot;
      /** True when Windows recovered a mutex abandoned by a dead peer. */
      readonly recoveredAbandonedLock: boolean;
    }
  | {
      readonly status: 'stale';
      readonly currentRevision: string;
    }
  | {
      /** The replacement linearized, but its durability or rollback could not be proven. */
      readonly status: 'committed_uncertain';
      readonly before: KodaXTrustedTextFileSnapshot;
      readonly after: KodaXTrustedTextFileSnapshot;
      readonly recoveredAbandonedLock: boolean;
      readonly reason: string;
    };

/**
 * Host-owned trusted text authority. It performs final canonical policy
 * validation, no-follow traversal, cross-Runtime locking, locked CAS, flush,
 * and atomic replacement without entering the shell sandbox graph.
 */
export interface KodaXTrustedTextMutationHost {
  snapshot(input: {
    readonly path: string;
    readonly createParentDirectories: boolean;
    readonly signal?: AbortSignal;
  }): Promise<KodaXTrustedTextFileSnapshot>;
  commit(input: KodaXTrustedTextCommitInput): Promise<KodaXTrustedTextCommitOutcome>;
}

/** Runtime-owned exact workspace roots shared by shell and direct text tools. */
export interface KodaXWorkspaceSandboxRootRegistry {
  list(): readonly string[];
  register(root: string): Promise<void>;
  unregister(root: string): Promise<void>;
}

export interface KodaXContextOptions {
  /**
   * Runtime-authenticated authority for permission review. Child runtimes must
   * preserve the root request and add delegation metadata instead of treating
   * their generated briefing as a new user authorization.
   */
  permissionIntent?: import('@kodax-ai/agent').GuardrailPermissionIntent;
  /** Runtime-owner config home used by Memory, review inbox, and Learned Area routing. */
  configHome?: string;
  /** Runtime-internal shared work ledger inherited by every descendant Agent run. */
  managedWorkBudget?: KodaXManagedWorkBudget;
  /** FEATURE_260 runtime-owned identity used for scoped memory reads. */
  memoryIdentity?: MemoryContextIdentity;
  /** Runtime-built F228 pack reused by prompt rendering and MemorySession. */
  memoryPack?: MemoryPack;
  /** Runtime-minted collaboration principal for this actor execution. */
  actorControl?: AgentActorClient;
  /**
   * Exact MessageQueue route for the Actor execution. Actor children keep
   * independent transcript session ids, so their collaboration mailbox cannot
   * be derived from the child run's session id.
   *
   * @internal
   */
  actorQueueAgentId?: string;
  /**
   * Stable logical Session namespace used only for context identity. Child
   * transcripts remain isolated under their physical worker Session ids.
   *
   * @internal
   */
  contextIdentitySessionId?: string;
  /**
   * Whether compaction in this physical run owns the canonical context
   * revision. Synthetic digest/repair requests share attribution but not
   * canonical history ownership.
   *
   * @internal
   */
  ownsContextRevision?: boolean;
  /** Trusted host operations that are intentionally absent from model-facing clients. */
  actorHost?: KodaXActorHost;
  /** Runtime-owned session Actor tree; attached when a root run builds its tool context. */
  actorSession?: import('./agent-runtime/actor-runtime.js').CodingActorSession;
  /**
   * Runtime-owned admission window for interrupt input targeted at the active
   * run. Its presence opts the managed Runner into consuming already-accepted
   * input before a terminal candidate is allowed to complete.
   *
   * @internal
   */
  interruptInput?: {
    closeInputWindow(): void;
    reopenInputWindow(): void;
  };
  /** Host attribution for an explicit Workflow command, SDK request, or natural-language product word. */
  workflowIntent?: 'explicit';
  /** Project root used for project-scoped prompts, permissions, and path policy. */
  gitRoot?: string | null;
  /**
   * Explicit working directory used for prompt context, relative tool paths,
   * and shell execution. Defaults to `gitRoot`, then `process.cwd()`.
   */
  executionCwd?: string;
  /** Optional host-owned shell/environment resolution policy for command tools. */
  shellExecution?: KodaXShellExecutionContract;
  /** Runtime-owned OS sandbox broker; never accepted from serialized model input. */
  shellSandbox?: KodaXShellSandbox;
  /** Runtime-owned trusted host transaction authority for direct text tools. */
  trustedTextMutationHost?: KodaXTrustedTextMutationHost;
  /** Runtime-owned linked-worktree roots; never accepted from model input. */
  workspaceSandboxRoots?: KodaXWorkspaceSandboxRootRegistry;
  /** Fail-closed host policy applied to every concrete file a read tool opens. */
  assertReadablePath?: (candidate: string) => void;
  /**
   * Best-known token snapshot for the current conversation history.
   * When present, the core will prefer it over local estimation and rebase it as
   * messages change.
   */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
  /** Optional semantic hints for provider-policy evaluation. */
  providerPolicyHints?: KodaXProviderPolicyHints;
  /** Optional repository routing signals that downstream planning layers can reuse. */
  repoRoutingSignals?: KodaXRepoRoutingSignals;
  /** Optional repo-intelligence mode override for this run. */
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
  /** Optional repo-intelligence trace toggle for this run. */
  repoIntelligenceTrace?: boolean;
  /**
   * Optional runtime-context diagnostics for SDK/daemon hosts. When false or
   * omitted, no extra budget/exposure calculation is performed.
   */
  contextDiagnostics?: boolean;
  disableAutoTaskReroute?: boolean;
  /**
   * FEATURE_087/088 (v0.7.28): when true, the prompt builder injects a
   * Tool Construction section that orients the LLM to the
   * scaffold_tool → validate_tool → stage_construction → test_tool →   * activate_tool staircase. Off by default; the surrounding agent (REPL
   * config or task router) flips this on when self-construction is
   * authorized for the session. The corresponding builtin tool handlers
   * are still gated independently by the active-tool set.
   */
  toolConstructionMode?: boolean;
  /** Skills system prompt snippet for progressive disclosure - Skills 系统提示词片段（渐进式披露） */
  skillsPrompt?: string;
  /** Optional run-scoped registry used to pin and restrict Skill invocation. */
  skillRegistry?: ISkillRegistry;
  /** Runtime-owned complete formal-name inventory used to prevent learned Skill shadowing. */
  protectedFormalSkillNames?: readonly string[];
  /**
   * Opaque root-run binding used to correlate learned Skill usage with the
   * exact Memory episode produced by that run.
   *
   * @internal
   */
  learnedSkillBindingId?: string;
  /** Runtime-owner admission for exact learned Skill revisions. */
  admitLearnedSkillInvocation?: (input: {
    readonly sessionId: string;
    readonly capabilityId: string;
    readonly revision: number;
    readonly fingerprint: string;
  }) => Promise<{ readonly invocationId: string }>;
  /** Runtime-owner outcome correlation for learned Skill canaries. */
  completeLearnedSkillOutcomes?: (input: {
    readonly sessionId: string;
    readonly outcome: 'verified_success' | 'credible_negative' | 'inconclusive';
    readonly evidenceRefs: readonly string[];
  }) => Promise<void>;
  /** Remote-runtime broker for explicitly admitted, OS-sandboxed Skill scripts. */
  skillScriptRunner?: KodaXSkillScriptRunner;
  rawUserInput?: string;
  skillInvocation?: KodaXSkillInvocationContext;
  /** Optional repository-intelligence snapshot injected into the system prompt. */
  repoIntelligenceContext?: string;
  /** Optional user-supplied artifacts carried with the current prompt. */
  inputArtifacts?: KodaXInputArtifact[];
  /** Internal execution-mode overlay appended to the system prompt */
  promptOverlay?: string;
  /**
   * Scoped specialist-agent resolver for embedders that run multiple
   * projects/sessions in one process. When absent, constructed-agent
   * lookups use the legacy process-global registry.
   */
  agentScope?: KodaXAgentScope;
  /** FEATURE_258: host-bound external-agent plane and non-model dispatch context. */
  agentExecutorPlane?: AgentExecutorPlaneBinding;
  /** Optional task-engine surface label used to track managed tasks across UX entry points. */
  taskSurface?: KodaXTaskSurface;
  /**
   * Host-provided live-turn attribution for this invocation. Embedders that
   * resume, interrupt, or deliver queued prompts outside KodaX's own queue can
   * preserve the real delivery kind without the SDK guessing from event order.
   */
  liveTurn?: {
    deliveryKind?: KodaXTurnDeliveryKind;
    turnId?: string;
    deliveryId?: string;
    promptId?: string;
  };
  /** Optional directory where managed task artifacts should be written. */
  managedTaskWorkspaceDir?: string;
  /** Internal managed-worker protocol emission configuration. */
  managedProtocolEmission?: {
    enabled: boolean;
    role: Exclude<KodaXTaskRole, 'direct'>;
    /** When true, protocol emission is available but not required. Auto-continue won't fire for missing protocol. */
    optional?: boolean;
  };
  /** Mutable mutation tracker shared between worker events and the protocol tool handler. */
  mutationTracker?: ManagedMutationTracker;
  /** FEATURE_067 v3: Tool names to exclude from API-level tool list (child agents). */
  excludeTools?: readonly string[];
  /**
   * FEATURE_247 (R2) — profile-scoped tool visibility predicate applied when the
   * model-visible tool list is built (in addition to `excludeTools`). Tools for
   * which it returns `false` are hidden from the model. Absent ⇒ no policy (only
   * `excludeTools` applies) — the default Coding Agent path is unchanged.
   */
  toolVisibilityPolicy?: KodaXToolVisibilityPolicy;
  /**
   * FEATURE_067 v3: Override the entire system prompt for this run.
   * When set, buildSystemPromptSnapshot is skipped — only this string is used.
   * Used for child agents that need a focused, lightweight prompt instead of the full system.
   */
  systemPromptOverride?: string;
  /** Optional structured metadata carried into the managed task contract. */
  taskMetadata?: Record<string, KodaXJsonValue>;
  /** Optional structured verification contract carried into managed tasks. */
  taskVerification?: KodaXTaskVerificationContract;
  /**
   * FEATURE_247 — SDK-consumer agent profile (KodaX-Space Partner et al).
   * Opaque identity + optional AMA-path instructions + optional default verifier
   * standard. Absent ⇒ the default Coding Agent (no behavioral change). See
   * {@link KodaXAgentProfile}.
   */
  agentProfile?: KodaXAgentProfile;
  /**
   * FEATURE_074: Plan-mode block predicate provided by the parent REPL. The predicate
   * closes over live parent state so mid-run mode toggles propagate to in-flight
   * children. Returns the block reason for currently-plan-mode-violating calls, or
   * `null` when the call is allowed right now. When absent, children run without
   * plan-mode enforcement.
   */
  planModeBlockCheck?: (tool: string, input: Record<string, unknown>) => string | null;
  /**
   * FEATURE_123 v0.7.44 — propagate the current agent's id into the
   * spawned runtime so its tools can self-identify (and so peer
   * `send_message` calls can stamp a `from=...` framing tag + reject
   * self-targeted sends).
   */
  currentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — propagate the dispatching agent's id (the
   * parent of the soon-to-be-spawned runtime) so `send_message(to:
   * "worker")` from a grand-child routes to its direct parent rather
   * than the top-level Worker.
   */
  parentAgentId?: string;
  /**
   * FEATURE_192 v0.7.44 Phase F — `/goal` runtime binding.
   *
   * When set, the runner-driven adapter:
   *   1. Wires `binding.goalContext` onto the tool-execution context
   *      so the 3 goal tools (get_goal / create_goal / update_goal)
   *      read + mutate live state.
   *   2. Wraps the `beforeNextTurn` hook with `withGoalBeforeNextTurn`
   *      for turn-end token + wall-time accounting and budget-limit
   *      transitions.
   *   3. Wraps the `stopHook` with `withGoalStopHook` so a Worker
   *      text-only termination with an active goal returns a
   *      continuation prompt (auto-continue on goal).
   *
   * Constructed by the REPL via `buildGoalRuntimeBinding(deps)` from
   * `packages/coding/src/goal/runtime-wiring.ts`. When undefined, the
   * tool context falls back to `makeDisabledGoalToolsContext()` and
   * the lifecycle hooks pass through unmodified.
   */
  goalRuntime?: import('./goal/runtime-wiring.js').GoalRuntimeBinding;

  /**
   * FEATURE_132 (v0.7.47) — native LSP service for edit-time diagnostics
   * reflux. When omitted, `buildToolExecutionContext` falls back to the
   * process-wide default (`getDefaultLspService()`), so diagnostics work
   * out of the box; hosts/tests inject their own to control or disable it.
   *
   * See `packages/coding/src/lsp/service.ts`.
   */
  lspService?: import('./lsp/service.js').LspService;
}

/**
 * FEATURE_221 — an SDK consumer (a product built on KodaX, e.g. KodaX-Space)
 * injects its own product manual so that when ITS users ask "how do I use /
 * configure <product>?", the kodax_manual tool answers with the consumer's
 * topics. `topics` extend the seeded base (override by id, then append);
 * `productName` re-brands the routing rule + scope anchor. Exact topic bodies
 * remain complete; the shared tool-result admission layer owns capacity.
 *
 * `baseTopics` controls how much of KodaX's own manual is present underneath:
 * omit it for the default full base, `[]` for a full white-label replace, or a
 * curated subset (e.g. `KODAX_UNDERLYING_CAPABILITY_TOPICS`) to keep only the
 * mechanism topics a product built on KodaX inherits. For build-time docs, a
 * consumer can import `MANUAL_REGISTRY` to read the base topic bodies directly.
 */
export interface KodaXSelfManualConfig {
  readonly productName?: string;
  readonly topics?: readonly KodaXManualTopicInput[];
  /**
   * Which KodaX base topics to seed before `topics` is layered on. `undefined`
   * ⇒ all base topics (default). `[]` ⇒ none (full replace). A subset ⇒ exactly
   * those ids. See {@link ResolveKodaXManualOptions.baseTopics}.
   */
  readonly baseTopics?: readonly KodaXManualTopicId[];
}

/**
 * SDK-consumer auto-compaction override. When a field is provided it wins
 * over both the adaptive default and `~/.kodax/config.json`. Lets an
 * embedder that calls `runManagedTask` in-process pin the context window /
 * trigger for a model the built-in capability table doesn't cover (or that
 * it resolves through a custom provider), or tune the always-on compaction
 * policy for a run — without writing to the user's home-dir config file. Omitted fields
 * fall through to the normal resolution cascade.
 */
export interface KodaXCompactionOverride {
  /** Override the resolved provider context window, in tokens. */
  contextWindow?: number;
  /** Override the auto-compaction trigger percentage (normalized to 15-90). */
  triggerPercent?: number;
  /** Optional absolute token threshold. Missing/zero is inactive. */
  triggerTokens?: number;
  /** @deprecated Automatic large compaction is always enabled. */
  enabled?: boolean;
}

/**
 * FEATURE_222 skill security — host policy for a skill's `!`cmd`` dynamic-context
 * tokens. By default (both fields unset) the LLM-triggered `skill` tool runs
 * those commands via the built-in allowlist + `execSync` — fine for the trusted
 * standalone CLI, but an embedder host (KodaX-Space) wants every shell touch to
 * go through its own permission broker. Set `execute` to route each `!`cmd``
 * through the host, or `disable: true` to refuse them outright.
 */
export interface KodaXSkillDynamicContextPolicy {
  /** Host hook run for each `!`cmd`` token (command, cwd) → stdout. Mediate via
   *  the host's permission broker; throw to refuse a command. */
  execute?: SkillDynamicContextExecutor;
  /** When true, every `!`cmd`` token is refused without executing anything. */
  disable?: boolean;
}

export interface KodaXOptions {
  provider: string;
  model?: string;
  modelOverride?: string;
  effort?: KodaXWireReasoningEffort;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  /** Total concurrent Agent turns for one session, including the root. Defaults to 4. */
  maxConcurrentThreadsPerSession?: number;
  maxIter?: number;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events?: KodaXEvents;
  memoryReviewer?: MemoryReviewRunner;
  /** One-call F263 reviewer. When present it replaces the memory-only reviewer for episode jobs. */
  learningReviewer?: UnifiedLearningReviewRunner;
  /** Optional host-owned semantic selector for sparse governed memory interventions. */
  memoryRecallRunner?: MemoryRecallRunner;
  extensionRuntime?: ExtensionRuntimeContract;
  /** FEATURE_229: host-owned policy for workflow auto-start and ceilings. */
  workflowHostPolicy?: import('./workflows/invocation-policy.js').WorkflowHostPolicy;
  /**
   * FEATURE_246 Part A2 (ADR-046): durable run-graph base dir for workflow runs
   * the model launches via `run_workflow`. The host (REPL / SDK) resolves it
   * (e.g. `getAgentConfigPath('workflow-runs', projectKey)`); when set + the
   * agent mode is ama/amaw, the tool-execution context wires `ctx.workflowHost`.
   */
  workflowRunsBaseDir?: string;
  /**
   * M2 — per-agent model TIERS for the workflow / dispatch `model_hint`. An
   * embedder maps the semantic tiers to concrete models; a workflow script /
   * dispatch then expresses intent via `modelHint: 'fast' | 'deep'` (NOT a
   * concrete model name — the authoring model has no cognition of the
   * embedder's configured providers). 'fast' routes read-only children only
   * (write/codegen stays on the parent — a quality guard); 'deep' routes any
   * child; an unset tier inherits the parent provider/model. Carried run-scoped
   * (AsyncLocalStorage) by runManagedTask so concurrent SDK sessions never
   * clobber each other; KODAX_FAST/DEEP_PROVIDER/MODEL is the env fallback used
   * by the CLI / config.json path.
   */
  modelTiers?: {
    readonly fast?: { readonly provider?: string; readonly model?: string };
    readonly deep?: { readonly provider?: string; readonly model?: string };
  };
  /**
   * Config-surface SDK peers for settings the llm layer otherwise reads via env.
   * Carried run-scoped (AsyncLocalStorage) by runManagedTask so concurrent SDK
   * sessions are isolated; the KODAX_* env vars are the CLI/config.json fallback.
   * `maxOutputTokens` caps every provider call; `disablePromptCache` turns off
   * Anthropic prompt caching; `lsp: false` disables LSP-assisted diagnostics.
   */
  maxOutputTokens?: number;
  disablePromptCache?: boolean;
  lsp?: boolean;
  /**
   * Workflow engine run-scoped overrides. `maxConcurrency` caps how many child
   * agents a `run_workflow` fans out at once (default 8, clamped to [1, 32]); the
   * `KODAX_WORKFLOW_MAX_CONCURRENCY` env var (bridged from config.json) is the
   * CLI fallback. Carried run-scoped so concurrent SDK sessions stay isolated.
   */
  workflow?: {
    readonly maxConcurrency?: number;
  };
  /** Host environment names exposed only to final command targets. Defaults to none. */
  sandbox?: KodaXSandboxOptions;
  /** FEATURE_221: SDK-consumer self-manual injection (product name + topics). */
  selfManual?: KodaXSelfManualConfig;
  /**
   * FEATURE_222 skill security: host policy for skill `!`cmd`` dynamic-context.
   * Absent → built-in allowlist+execSync (trusted-CLI default). See
   * {@link KodaXSkillDynamicContextPolicy}.
   */
  skillDynamicContext?: KodaXSkillDynamicContextPolicy;
  /**
   * FEATURE_092 (v0.7.33): caller-supplied run-scoped guardrails forwarded
   * to `Runner.run` via `RunOptions.guardrails`. Merged with the START
   * agent's declared guardrails (agent-first, then opts). The REPL injects
   * the AutoModeToolGuardrail here when `permissionMode === 'auto'`; SDK
   * consumers can inject custom ToolGuardrail / InputGuardrail / OutputGuardrail
   * instances. Empty / undefined leaves the agent's own declaration unchanged.
   */
  guardrails?: readonly import('@kodax-ai/agent').Guardrail[];
  /** AbortSignal for cancelling the API request */
  abortSignal?: AbortSignal;
  /**
   * v0.7.42 — `RunningSession` plumbing (closes gap 6 reported by KodaX
   * Space). When provided, the substrate `_attach`es low-level mutators
   * onto this control object so the embedder can flip provider / model
   * / reasoning between turns without restarting the run. The mutations
   * land on the live `RuntimeSessionState` and are picked up by the
   * next-turn CAP-055 provider re-resolution. `startKodaX` (the
   * non-blocking entry) is the canonical producer of this field; direct
   * SDK callers can also instantiate one via {@link createSessionControl}.
   */
  sessionControl?: KodaXSessionControl;
  /**
   * SDK-consumer auto-compaction override. Wins over the adaptive default
   * and `~/.kodax/config.json`. See {@link KodaXCompactionOverride}.
   */
  compaction?: KodaXCompactionOverride;
  /**
   * SDK-consumer timeout budgets for user-facing waits. Values are seconds at
   * the public API boundary; KodaX converts them to milliseconds internally.
   * This does not control internal cleanup/resource-protection watchdogs.
   */
  timeouts?: KodaXTimeoutConfig;
}

export interface KodaXSandboxOptions {
  /** Exact host environment-variable names; values are never carried in this option. */
  readonly envPass?: readonly string[];
}

/**
 * Low-level mutators handed to a `KodaXSessionControl` by the substrate.
 * Each setter writes directly into the live `RuntimeSessionState`. Called
 * exactly once per session (just after `buildRuntimeSessionState`).
 */
export interface KodaXSessionMutators {
  setProvider(name: string): void;
  setModel(model: string | undefined): void;
  setReasoning(mode: KodaXReasoningMode | undefined): void;
}

/**
 * Embedder-facing control surface. Created by the embedder (or by
 * `startKodaX`), passed in via `KodaXOptions.sessionControl`. The
 * substrate calls `_attach` once, after which the control's setter
 * methods apply live to the in-flight run.
 */
export interface KodaXSessionControl {
  /** @internal — wired by `run-substrate`. Do not call from user code. */
  _attach(mutators: KodaXSessionMutators): void;
}

// ============== 结果类型 ==============

export type KodaXTaskSurface = 'cli' | 'repl' | 'plan';
export type KodaXTaskStatus = 'planned' | 'running' | 'blocked' | 'failed' | 'completed';
// FEATURE_114 v0.7.36: 'worker' is the AMA Harness V2 role that collapses
// scout/planner/generator into a single primary agent driving plan + exec
// behind the KODAX_HARNESS_V2 flag. Evaluator stays a separate role.
// Legacy roles (scout/planner/generator/evaluator) remain on the V1 path
// until v0.7.45 cleanup; both paths share the role-prompt switch.
export type KodaXTaskRole = 'direct' | 'scout' | 'planner' | 'generator' | 'evaluator' | 'worker';

export interface KodaXTaskContract {
  taskId: string;
  surface: KodaXTaskSurface;
  objective: string;
  createdAt: string;
  updatedAt: string;
  status: KodaXTaskStatus;
  primaryTask: KodaXTaskType;
  workIntent: KodaXTaskWorkIntent;
  complexity: KodaXTaskComplexity;
  riskLevel: KodaXRiskLevel;
  harnessProfile: KodaXHarnessProfile;
  recommendedMode: KodaXExecutionMode;
  requiresBrainstorm: boolean;
  reason: string;
  contractSummary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
  contractCreatedByAssignmentId?: string;
  contractUpdatedAt?: string;
  metadata?: Record<string, KodaXJsonValue>;
  verification?: KodaXTaskVerificationContract;
}

export interface KodaXTaskRoleAssignment {
  id: string;
  role: KodaXTaskRole;
  title: string;
  dependsOn: string[];
  status: KodaXTaskStatus;
  agent?: string;
  toolPolicy?: KodaXTaskToolPolicy;
  summary?: string;
  sessionId?: string;
}

export interface KodaXTaskWorkItem {
  id: string;
  assignmentId: string;
  description: string;
  execution: 'serial' | 'parallel';
}

export interface KodaXTaskEvidenceArtifact {
  kind: 'json' | 'text' | 'markdown' | 'image';
  path: string;
  description?: string;
}

export interface KodaXTaskEvidenceEntry {
  assignmentId: string;
  role: KodaXTaskRole;
  status: KodaXTaskStatus;
  title?: string;
  round?: number;
  summary?: string;
  output?: string;
  sessionId?: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
}

export interface KodaXTaskEvidenceBundle {
  workspaceDir: string;
  runId?: string;
  artifacts: KodaXTaskEvidenceArtifact[];
  entries: KodaXTaskEvidenceEntry[];
  routingNotes: string[];
}

export interface KodaXOrchestrationVerdict {
  status: KodaXTaskStatus;
  decidedByAssignmentId: string;
  summary: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  disposition?: 'complete' | 'blocked' | 'needs_continuation';
}

export interface KodaXManagedTaskRuntimeState {
  childContextBundles?: KodaXChildContextBundle[];
  childAgentResults?: KodaXChildAgentResult[];
  parentReductionContract?: KodaXParentReductionContract;
  budget?: KodaXManagedBudgetSnapshot;
  scorecard?: KodaXVerificationScorecard;
  qualityAssuranceMode?: 'required' | 'optional';
  memoryStrategies?: Record<string, KodaXMemoryStrategy>;
  memoryNotes?: Record<string, string>;
  roleRoundSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
  routingAttempts?: number;
  routingSource?: KodaXTaskRoutingDecision['routingSource'];
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  harnessTransitions?: KodaXManagedTaskHarnessTransition[];
  // FEATURE_193 (v0.7.43) deep V1 cleanup: V1 Scout role retired. The
  // SDK fields `scoutDecision` (Scout's harness/scope decision) and
  // `skillMap` (Scout's skill-projection slot) have been removed
  // physically — V2 Worker reads skillMap / scope context via
  // `ctx.skillInvocation` and the routing-overlay system-prompt section
  // (FEATURE_143) instead.
  completionContractStatus?: Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'>;
  rawRoutingDecision?: KodaXTaskRoutingDecision;
  finalRoutingDecision?: KodaXTaskRoutingDecision;
  routingOverrideReason?: string;
  providerRuntimeBehavior?: {
    downgraded?: boolean;
    reasons: string[];
  };
  degradedVerification?: {
    fallbackWorkerId?: string;
    reason: string;
    debugReason?: string;
  };
  degradedContinue?: boolean;
  reviewFilesOrAreas?: string[];
  toolOutputTruncated?: boolean;
  toolOutputTruncationNotes?: string[];
  /**
   * Warn-only todo hygiene telemetry: successful real work started while
   * pending todos existed and no item was marked in_progress. The runner
   * never mutates todo state from this signal.
   */
  todoDriftWarnings?: KodaXTodoDriftWarningEvent[];
  managedTimeline?: KodaXManagedLiveEvent[];
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
  consecutiveEvidenceOnlyIterations?: number;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs. */
  childWriteReviewPrompt?: string;
  /** FEATURE_067: Number of write child diffs pending evaluator review. */
  childWriteDiffCount?: number;
}

export interface KodaXManagedTask {
  contract: KodaXTaskContract;
  roleAssignments: KodaXTaskRoleAssignment[];
  workItems: KodaXTaskWorkItem[];
  evidence: KodaXTaskEvidenceBundle;
  verdict: KodaXOrchestrationVerdict;
  runtime?: KodaXManagedTaskRuntimeState;
}

export interface KodaXManagedVerdictPayload {
  /** FEATURE_184 (v0.7.45): `'sidecar'` is the new architectural source —   *  Sidecar Verifier replaces the in-chain Evaluator role. `'evaluator'`
   *  / `'worker'` are retained for backward-compat reads of session jsonl
   *  written before v0.7.45. New writes use `'sidecar'`. */
  source: 'evaluator' | 'worker' | 'sidecar';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  debugReason?: string;
  followups: string[];
  userFacingText: string;
  userAnswer?: string;
  artifactPath?: string;
  rawArtifactPath?: string;
  rawResponseText?: string;
  nextHarness?: KodaXTaskRoutingDecision['harnessProfile'];
  protocolParseFailed?: boolean;
  verificationDegraded?: boolean;
  strategyReasonCode?:
    | 'missing_requirement'
    | 'contradicted_evidence'
    | 'unsupported_claim'
    | 'unresolved_high_risk'
    | 'verification_degraded';
  recommendedPattern?:
    | 'classify-and-act'
    | 'fan-out-and-synthesize'
    | 'adversarial-verification'
    | 'generate-and-filter'
    | 'tournament'
    | 'loop-until-done';
  targetEvidenceRefs?: string[];
  preferredFallbackWorkerId?: string;
  /**
   * v0.7.26 Risk-3 fix — Evaluator explicit budget-extension request.
   * When present, the Runner-driven `wrapEmitterWithRecorder` fires the
   * budget-extension dialog regardless of the 90% threshold, using this
   * string as the user-visible summary. Mirrors legacy Evaluator's
   * `budgetRequest` field which was parsed from the fenced-block
   * `kodax-budget-request` payload in v0.7.22.
   */
  budgetRequest?: string;
}

/**
 * Signals surfaced by the harness (not the LLM) when V1 Scout's completion
 * looked suspicious.
 *
 * FEATURE_193 (v0.7.43) deep V1 cleanup: V1 Scout role is retired and the
 * Runner-driven path no longer fires `onScoutSuspiciousCompletion`. The
 * type is kept on the SDK surface so the `KodaXEvents.onScoutSuspiciousCompletion`
 * callback signature continues to compile for pre-1.0 SDK consumers (e.g.
 * the REPL renderers that still register a handler). New code MUST NOT
 * emit this signal.
 */
export type KodaXScoutSuspiciousSignal =
  | 'mutation-expected-but-none'
  | 'budget-exhausted'
  | 'no-formal-completion';

// FEATURE_193 (v0.7.43) deep V1 cleanup: the V1 chain payload slots
// (`scout` / `contract` / `handoff`) and their slice type defs
// (`KodaXManagedScoutPayload` / `KodaXManagedContractPayload` /
// `KodaXManagedHandoffPayload`) have been removed physically — V1 chain
// retired, no V2 caller mints these payloads. Only the verdict slot
// remains; the Sidecar Verifier (FEATURE_184) is the sole emitter on V2.
export interface KodaXManagedProtocolPayload {
  verdict?: KodaXManagedVerdictPayload;
}

export interface KodaXRuntimeSessionSnapshot {
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
}

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
  /**
   * FEATURE_247 — the agent profile this run executed under, echoed verbatim from
   * `options.context.agentProfile`. Lets an embedder confirm the running profile
   * was Partner (not the default Coding Agent). Absent ⇒ default Coding Agent.
   */
  agentProfile?: KodaXAgentProfile;
  /** Internal raw protocol output retained for artifact persistence after compacting visible failure text. */
  protocolRawText?: string;
  /** Structured managed-task protocol payload separated from visible text. */
  managedProtocolPayload?: KodaXManagedProtocolPayload;
  /** Final visible routing decision for this run, including harness and work intent. */
  routingDecision?: KodaXTaskRoutingDecision;
  /** Managed task summary produced by the task engine for this run. */
  managedTask?: KodaXManagedTask;
  /** Best-known token snapshot after the round completes. */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  /** Latest provider usage when the caller has it directly. */
  usage?: KodaXTokenUsage;
  /** Serializable runtime-owned session state for host-owned persistence. */
  runtimeSessionSnapshot?: KodaXRuntimeSessionSnapshot;
  /**
   * FEATURE_076: artifact ledger pre-extracted before round-boundary reshape.
   * Populated when the reshape replaces `messages` with a clean {user, assistant}
   * dialog — tool_result blocks (the source of artifact ledger entries) no
   * longer live in `messages` after reshape. REPL consumers should read this
   * field first, falling back to `extractArtifactLedger(messages)` for
   * backward compatibility on code paths that have not yet been updated.
   */
  artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  /** 是否被用户中断 (Ctrl+C) */
  interrupted?: boolean;
  /** 是否达到迭代上限 */
  limitReached?: boolean;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== 工具执行上下文 ==============
// Simplified - no permission checks in core

// FEATURE_222 — the user-interaction types now live at the agent layer so the
// MCP elicitation reverse capability can share the same primitive. Re-exported
// here for backward compatibility (existing `../types.js` imports keep working).
import type {
  AskUserAnswer,
  AskUserCustomInputAnswer,
  AskUserQuestionItem,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  AskUserSelectionAnswer,
} from '@kodax-ai/agent';
export type {
  AskUserAnswer,
  AskUserCustomInputAnswer,
  AskUserQuestionItem,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  AskUserSelectionAnswer,
};

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Runtime-minted collaboration principal; model inputs cannot replace its caller path. */
  actorControl?: AgentActorClient;
  /** Runtime-minted MessageQueue route for this Actor's collaboration mailbox. */
  actorQueueAgentId?: string;
  /** Stable logical Session namespace used for child context identity. */
  contextIdentitySessionId?: string;
  /** Runtime-minted exact Actor/Turn owner for collaboration metadata. */
  actorTurnRef?: { readonly actorPath: string; readonly turnId: string };
  /** Shared root-run work ledger; descendant runtimes retain this exact object. */
  managedWorkBudget?: KodaXManagedWorkBudget;
  /** Trusted permission authority inherited independently of child transcripts. */
  permissionIntent?: import('@kodax-ai/agent').GuardrailPermissionIntent;
  /** Trusted host operations that are intentionally absent from model-facing clients. */
  actorHost?: KodaXActorHost;
  /** FEATURE_260: current exactly-scoped read-only MemorySession query binding. */
  memoryRecall?: (need: string) => Promise<{
    readonly content: string;
    readonly evidenceRefs: readonly string[];
  } | undefined>;
  /**
   * @deprecated Legacy end-of-episode explicit Memory-intent capture callback.
   * Hosts may keep providing this callback; the conversation-first management
   * tool never sends its broader operation protocol through this seam.
   */
  memoryIntent?: (input: {
    readonly operation: 'remember' | 'correct';
    readonly statement: string;
    readonly userQuote: string;
  }) => Promise<
    | {
        readonly status: 'captured';
        readonly operation: 'remember' | 'correct';
        readonly evidenceRef: string;
      }
    | {
        readonly status: 'rejected';
        readonly reason: string;
      }
  >;
  /** Root-session-only conversation-first Memory management channel. */
  memoryManagementIntent?: (input: {
    readonly operation:
      | 'list'
      | 'remember'
      | 'correct'
      | 'forget'
      | 'decisions'
      | 'show'
      | 'approve'
      | 'reject';
    readonly statement?: string;
    readonly targetRefId?: string;
    readonly claimKind?: 'fact' | 'policy' | 'preference' | 'procedure';
    readonly claimKey?: string;
    readonly userQuote?: string;
    readonly reason?: string;
  }) => Promise<
    | {
        readonly status: 'listed';
        readonly operation: 'list';
        readonly total: number;
        readonly memories: readonly {
          readonly refId: string;
          readonly title: string;
          readonly body: string;
          readonly bodyFingerprint: string;
        }[];
      }
    | {
        readonly status: 'decisions';
        readonly operation: 'decisions';
        readonly total: number;
        readonly decisions: readonly {
          readonly refId: string;
          readonly summary: string;
          readonly rationale: string;
          readonly risk: 'low' | 'medium' | 'high';
          readonly proposedBody?: string;
        }[];
      }
    | {
        readonly status: 'shown';
        readonly operation: 'show';
        readonly decision: {
          readonly refId: string;
          readonly summary: string;
          readonly rationale: string;
          readonly risk: 'low' | 'medium' | 'high';
          readonly proposedBody?: string;
        };
      }
    | {
        readonly status:
          | 'remembered'
          | 'updated'
          | 'already_known'
          | 'forgotten'
          | 'approved'
          | 'decision_rejected';
        readonly operation: 'remember' | 'correct' | 'forget' | 'approve' | 'reject';
        readonly changedRefIds: readonly string[];
      }
    | {
        readonly status: 'needs_clarification' | 'needs_review' | 'rejected';
        readonly operation: 'remember' | 'correct' | 'forget' | 'show' | 'approve' | 'reject';
        readonly reason: string;
        readonly decisionRefIds?: readonly string[];
      }
  >;
  /** Exact persisted history loader for the current root or isolated worker Session. */
  loadSessionHistory?: () => Promise<KodaXSessionLineage | null>;
  /** Git root directory - Git 鏍圭洰褰?*/
  gitRoot?: string;
  /**
   * FEATURE_247 (R7) — runtime-resolved session id for the run that owns this
   * tool call. Lets host-registered tools (Space artifact/source/KB) attribute a
   * call to the right session when multiple Partner/Coder sessions run
   * concurrently, without AsyncLocalStorage. Absent on paths that do not resolve
   * a session id (e.g. isolated tool tests).
   */
  sessionId?: string;
  /**
   * FEATURE_247 (R7) — id of the LLM `tool_use` block this execution backs
   * (same value surfaced as `KodaXToolEventMeta.toolId`). Lets a host correlate a
   * tool handler invocation to its event stream and de-duplicate retries.
   */
  toolCallId?: string;
  /**
   * FEATURE_247 (R7) — task surface/profile label forwarded from
   * `options.context.taskSurface`, so a tool handler can tell a Partner call from
   * a Coder call. Absent ⇒ not set by the caller.
   */
  taskSurface?: KodaXTaskSurface;
  /**
   * FEATURE_247 (R7) — SDK-consumer agent profile owning this tool call, echoed
   * from `options.context.agentProfile`. Absent ⇒ default Coding Agent.
   */
  agentProfile?: KodaXAgentProfile;
  /** Scoped specialist-agent resolver inherited from KodaXOptions.context. */
  agentScope?: KodaXAgentScope;
  /** FEATURE_258: external dispatch capability; absent keeps the tool surface unchanged. */
  agentExecutorPlane?: AgentExecutorPlaneBinding;
  /** FEATURE_221: SDK-consumer self-manual injection, forwarded from KodaXOptions. */
  selfManual?: KodaXSelfManualConfig;
  /** FEATURE_222 skill security — host policy for skill `!`cmd`` dynamic-context,
   *  forwarded from `KodaXOptions.skillDynamicContext`. Consumed by the `skill` tool. */
  skillDynamicContext?: KodaXSkillDynamicContextPolicy;
  /** Runtime-bound Skill registry; avoids process-global cross-session drift. */
  skillRegistry?: ISkillRegistry;
  /** Runtime-owner admission for exact learned Skill revisions. */
  admitLearnedSkillInvocation?: KodaXContextOptions['admitLearnedSkillInvocation'];
  /** Present only when the host admitted exact Skill scripts for this run. */
  skillScriptRunner?: KodaXSkillScriptRunner;
  /** Working directory used to resolve relative paths and execute shell commands. */
  executionCwd?: string;
  /** Validated shell execution policy inherited by native child runtimes. */
  shellExecution?: KodaXShellExecutionContract;
  /** Run-scoped command-target environment policy supplied by the SDK host. */
  sandbox?: KodaXSandboxOptions;
  /** Runtime-owned OS sandbox broker for selected concrete shell calls. */
  shellSandbox?: KodaXShellSandbox;
  /** Runtime-owned trusted host transaction authority for direct text tools. */
  trustedTextMutationHost?: KodaXTrustedTextMutationHost;
  /** Runtime-owned linked-worktree roots shared by shell and direct text tools. */
  workspaceSandboxRoots?: KodaXWorkspaceSandboxRootRegistry;
  /** Structured containment metadata; never model-visible or persisted as conversation text. */
  reportToolSandboxObservation?: (observation: KodaXShellSandboxObservation) => void;
  /**
   * Exact credential variable names owned by registered Providers.
   * Used only to remove non-standard `apiKeyEnv` names from child processes.
   *
   * @internal
   */
  providerCredentialEnvironmentNames?: readonly string[];
  /** Fail-closed host policy applied to every concrete file a read tool opens. */
  assertReadablePath?: (candidate: string) => void;
  /** Host tool visibility ceiling inherited by child agents. */
  toolVisibilityPolicy?: KodaXToolVisibilityPolicy;
  /** Static caller exclusions applied before constructing a model-visible tool schema. */
  excludeTools?: readonly string[];
  /** Maximum physical input capacity of the active model request. */
  maximumInputTokens?: number;
  /** Remaining capacity for the complete tool-result batch in this request. */
  toolResultCapacityTokens?: number;
  /** Runner path resolver for the transcript that the current batch extends. */
  resolveToolResultCapacityTokens?: (messages: readonly KodaXMessage[]) => number;
  /** Trusted side-channel for a tool-owned recovery artifact. */
  recordToolResultArtifact?: (toolCallId: string, outputPath: string) => void;
  /** Session-scoped directory for helper scripts and scratch outputs. */
  sessionScratchDir?: string;
  /**
   * Active skill invocation for the current managed run. Child dispatch uses
   * this to preserve the skill's support-file roots in sub-agent briefings.
   */
  skillInvocation?: KodaXSkillInvocationContext;
  /**
   * FEATURE_217 (v0.7.49): parent dir for `isolation:'worktree'` workflow child
   * worktrees. Workflow runs point this at `<runDir>/worktrees` so worktrees are
   * reclaimable (Layer 2/3 sweep) and never pollute the user's project tree.
   * Absent on non-workflow paths → worktrees fall back to the git root's parent.
   */
  workflowWorktreeBaseDir?: string;
  /** Shared extension capability runtime used by retrieval-family tools. */
  extensionRuntime?: CapabilityRuntimeContract;
  /** Ask user a question interactively (select mode) - Issue 069. Select
   *  answers may be strings, arrays, or structured custom-input answers. */
  askUser?: (options: AskUserQuestionOptions) => Promise<AskUserAnswer>;
  /** Ask user multiple independent questions sequentially - 澶氶棶棰橀『搴忔彁闂?*/
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, AskUserAnswer> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
  /**
   * FEATURE_074: Exit plan mode with user approval. Called by the `exit_plan_mode` tool.
   * See KodaXEvents.exitPlanMode for the tri-state return contract.
   */
  exitPlanMode?: (plan: string) => Promise<boolean | 'not-in-plan-mode'>;
  /** Abort signal for cancelling in-flight tool operations (Issue 113) */
  abortSignal?: AbortSignal;
  /**
   * FEATURE_121 v0.7.40 — last-resort LLM blob summarizer.
   *
   * Injected by `runner-driven.ts` at task-engine init using the
   * Worker's own provider/model (same panel, same key). The dispatch
   * tool calls this only when `applyToolResultGuardrail` returned
   * `spillFailed: true` AND the raw content exceeds
   * `LARGE_CONTENT_THRESHOLD_BYTES` (100 KB) — i.e., spill is broken
   * AND inlining the full payload would risk blowing context. The
   * callback compresses to roughly 2-10 KB while preserving structural
   * tokens (paths / line-numbers / error codes). On failure the caller
   * falls back to the existing inline-full-content path; callees are
   * expected to throw `BlobSummarizerError` on empty / aborted /
   * upstream-error.
   *
   * See `packages/coding/src/tools/blob-summarizer.ts`.
   */
  summarizeBlob?: (
    content: string,
    options?: { readonly maxChars?: number; readonly abortSignal?: AbortSignal },
  ) => Promise<string>;
  managedProtocolRole?: Exclude<KodaXTaskRole, 'direct'>;
  emitManagedProtocol?: (payload: Partial<KodaXManagedProtocolPayload>) => void;
  /** FEATURE_067 v2: Parent agent's provider/model for child agent inheritance. */
  parentAgentConfig?: {
    readonly provider: string;
    readonly model?: string;
    readonly reasoningMode?: KodaXReasoningMode;
    readonly effort?: KodaXWireReasoningEffort;
    readonly repoIntelligenceMode?: KodaXRepoIntelligenceMode;
    readonly repoIntelligenceTrace?: boolean;
    readonly compaction?: Readonly<KodaXCompactionOverride>;
    readonly contextDiagnostics?: boolean;
    readonly disablePromptCache?: boolean;
    readonly shellExecution?: KodaXShellExecutionContract;
    readonly sandbox?: KodaXSandboxOptions;
    readonly permissionIntent?: import('@kodax-ai/agent').GuardrailPermissionIntent;
  };
  /** Parent SDK/REPL callback surface used to preserve nested Agent telemetry. */
  parentEvents?: KodaXEvents;
  /**
   * FEATURE_123 v0.7.44 — agentId of the agent whose tool call this
   * context backs. `undefined` for the top-level Worker (main runtime
   * loop); set to the child's `bundle.id` for sub-agent runtimes.
   *
   * Wired by `child-executor.executeReadChild` / `executeWriteChild`
   * via `options.context.currentAgentId`.
   */
  currentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — agentId of the agent that dispatched the one
   * owning this context. `undefined` for the Worker (top of the tree)
   * and for first-tier children (parent == Worker; routing uses the
   * `'worker'` sentinel rather than an agentId). Set for grand-child
   * runtimes whose parent is itself a child.
   *
   */
  parentAgentId?: string;
  /**
   * FEATURE_123 v0.7.44 — per-turn `send_message` flood throttle counter.
   *
   * Legacy-compatible per-turn collaboration throttle counter. Actor controls
   * enforce their own topology and permission limits.
   */
  sendMessageTurnCounter?: { count: number };
  /**
   * @deprecated FEATURE_067: Removed — use reportToolProgress instead.
   * Previously fired onManagedTaskStatus with activeWorkerId='child',
   * triggering a foreground worker transition that cleared all live tool calls.
   */
  onChildProgress?: (note: string) => void;
  /** FEATURE_067 v2: Callback for long-running tools to report execution progress to the REPL transcript.
   *  The string will be displayed as the tool's "Running:" line in the transcript. */
  reportToolProgress?: (message: string) => void;
  /** Mutation tracker for scope-aware protocol responses. Populated by createWorkerEvents. */
  mutationTracker?: ManagedMutationTracker;
  /**
   * FEATURE_074: Predicate provided by the parent REPL that evaluates plan-mode
   * block reasons for child tool calls. Read lazily at each call — closes over
   * live parent state so mid-run mode toggles propagate into in-flight children.
   */
  planModeBlockCheck?: (tool: string, input: Record<string, unknown>) => string | null;

  /**
   * Parent-Runner guardrails surfaced into the tool-execution context so nested
   * Agent turns share the same mutable safety state. Sharing the SAME
   * guardrail instance means the auto-mode `engine` + `denialTracker` +
   * `circuitBreaker` state is observed across the parent/child boundary —
   * rate-limit by hitting the threshold from a fresh tracker).
   *
   * Single-process / single-thread execution makes the shared mutable state
   * safe under JS run-to-completion semantics — concurrent child tool calls
   * produce interleaved `recordBlock` / `recordAllow` updates with no tearing.
   */
  guardrails?: readonly import('@kodax-ai/agent').Guardrail[];
  /**
   * FEATURE_097 (v0.7.34): Scout-seeded todo plan store. Populated by
   * runner-driven setup whenever Scout's `executionObligations` reaches
   * the display threshold (≥2 entries); the `todo_update` tool reads
   * `has(id)` / `allIds()` for unknown-id error reasons and calls
   * `updateStatus(...)` for state transitions. The store emits its own
   * `onTodoUpdate` events via the `onChange` callback wired at creation
   * — tools do not have to forward events themselves.
   */
  todoStore?: import('./task-engine/todo-store.js').TodoStore;

  /**
   * FEATURE_125 v0.7.41 — Team Mode Layer 4 race-condition safety net.
   *
   * Cross-process content-hash cache. The Read tool records a sha256
   * of the file content at read time; Edit / MultiEdit / Write tools
   * check the recorded hash against the current on-disk hash before
   * mutating. A mismatch (peer or user-manual edit landed in the gap)
   * causes the tool to reject with a `{ok:false, reason:"...re-read first"}`
   * envelope rather than overwrite blindly.
   *
   * Created once per managed-task in `runner-driven.ts`, passed
   * through to every tool execution. When undefined (e.g., a tool is
   * called outside a managed task or `KODAX_DISABLE_MULTI_INSTANCE=1`
   * was set), the safety net is bypassed — tools fall back to the
   * single-process semantics.
   *
   * See `packages/coding/src/multi-instance/content-hash-cache.ts`.
   */
  contentHashCache?: import('./multi-instance/content-hash-cache.js').ContentHashCache;

  /**
   * FEATURE_132 (v0.7.47) — native LSP service. The write-family tools call
   * `getDiagnosticsBlock(filePath, …)` after a successful write to reflux any
   * type errors into the tool result. Forwarded by `buildToolExecutionContext`
   * from `options.context.lspService` or the process-wide default.
   */
  lspService?: import('./lsp/service.js').LspService;

  /**
   * FEATURE_177 v0.7.42 — per-task read-file-state cache (anti-loop).
   *
   * Tracks `(filePath, offset, limit)` tuples the LLM has already read
   * in this task. On a re-read with unchanged mtime, the Read tool
   * returns a short stub instead of the full content — breaking
   * `narrate-then-re-read` loops on models with structural decoder
   * floors (kimi-code 2026-05). Edit / Write / MultiEdit call `forget`
   * after a successful mutation; the compaction post-hook calls
   * `clear`. Disabled by `KODAX_READ_DEDUP_KILLSWITCH=1`.
   *
   * See `packages/coding/src/multi-instance/read-file-state-cache.ts`.
   */
  readFileStateCache?: import('./multi-instance/read-file-state-cache.js').ReadFileStateCache;

  /**
   * FEATURE_125 v0.7.41 — Team Mode Layer 3 input.
   *
   * Snapshot of sibling KodaX instances captured at the start of the
   * current LLM round by the runner-driven adapter. Mutation tools
   * (Edit / MultiEdit / Write) read this when present to detect
   * `activeFiles` overlap and prepend a soft warning to their tool
   * result. The snapshot is per-round (no automatic refresh during a
   * single tool execution) — slight staleness is acceptable; the
   * warning is informational, not a hard gate.
   *
   * When undefined (Team Mode disabled, solo session, or tool invoked
   * outside a managed task), the warning layer is bypassed silently.
   * The hard-block layer (`contentHashCache`) is independent and
   * still applies.
   *
   * See `packages/coding/src/multi-instance/active-file-warning.ts`.
   */
  siblingSnapshot?: readonly import('@kodax-ai/agent').DiscoveredInstance[];

  /**
   * FEATURE_192 v0.7.44 — `/goal` Persistent Goal runtime hook.
   *
   * Wired by the REPL adapter for every session with a lineage. When
   * undefined (sync-dispatch / isolated test harness), the 3 goal
   * tools (`get_goal` / `create_goal` / `update_goal`) fall back to a
   * uniform-error context (`makeDisabledGoalToolsContext`) so the
   * model gets a clear signal rather than a silent failure.
   *
   * See `packages/coding/src/goal/tools-context.ts`.
   */
  goalContext?: import('./goal/tools-context.js').GoalToolsContext;
  /**
   * FEATURE_246 Part A2 (ADR-046): narrow capability the `run_workflow` tool
   * uses to start a managed workflow run. Wired by tool-execution-context (via
   * a lazy import of the coding WorkflowHost) only when the session enables it;
   * absent in SA / when no runs dir is configured, so the tool fails closed.
   */
  workflowHost?: WorkflowToolHost;

}

/** Result of a model-launched workflow run (FEATURE_246 Part A2). */
export interface WorkflowToolHostResult {
  readonly kind: 'declined' | 'started';
  /** declined: why the host/generator declined to run. */
  readonly reason?: string;
  /** started: the minted run id. */
  readonly runId?: string;
  /** started: terminal status once the run settled. */
  readonly status?: string;
  /** started: the run's displayable result text, when completed. */
  readonly resultText?: string;
  /** started: terminal error message, when failed. */
  readonly error?: string;
  /** started: names of child agents that completed but FAILED their sidecar
   *  verification in warn-only mode (`agent_unverified`). The overall run still
   *  settles as `completed`, so without surfacing these the Worker would act on
   *  the result unaware that some verification failed. Empty/omitted = all
   *  completed children verified (or none were verified). */
  readonly verificationWarnings?: readonly string[];
  /** Diagnostic workflow-quality warnings found before the run started.
   *  These are non-blocking and are not rendered into model-visible
   *  `run_workflow` text by default; uncertain quality heuristics must not
   *  pressure the Worker into rewriting otherwise-valid workflows. */
  readonly workflowQualityWarnings?: readonly string[];
}

/**
 * Narrow ctx capability for launching workflows from a tool. Intentionally free
 * of any workflow-layer type import (keeps `types.ts` dependency-light); the
 * concrete implementation lives behind a lazy import in tool-execution-context.
 */
export interface WorkflowToolHostInlineInput {
  readonly manifest: unknown;
  readonly source: string;
  readonly args?: unknown;
  readonly resumeFromRunId?: string;
  /** Per-run abort signal, combined with the session signal. */
  readonly signal?: AbortSignal;
}

/** ADR-049: a started-but-not-awaited workflow handle. `done` resolves with the
 * terminal result when the run settles. The Workflow owner Actor exposes that
 * result without blocking the launching turn. */
export type WorkflowToolHostStartResult =
  | { readonly kind: 'declined'; readonly reason?: string }
  | {
      readonly kind: 'started';
      readonly runId: string;
      readonly done: Promise<WorkflowToolHostResult>;
      /** Non-blocking diagnostic preflight warnings available immediately at start. */
      readonly workflowQualityWarnings?: readonly string[];
    };

export interface WorkflowToolHost {
  /** Start an inline-authored workflow ({manifest, source}) and await its result.
   *  `resumeFromRunId` (FEATURE_246 Part D) seeds the result cache from a prior
   *  run so unchanged effects replay and only changed ones re-run live. */
  runInline(input: WorkflowToolHostInlineInput): Promise<WorkflowToolHostResult>;
  /** ADR-049: start the workflow and return immediately with a `done` promise,
   *  without blocking the calling turn. The async/idle-yield run_workflow path uses
   *  this; `runInline` is just `startInline` + `await done`. */
  startInline(input: WorkflowToolHostInlineInput): Promise<WorkflowToolHostStartResult>;
}

// FEATURE_200 Phase F: repo-intelligence domain extracted to ./types/repo-intelligence.ts.
import type {
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceTraceEvent,
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceTrace,
} from './types/repo-intelligence.js';
export * from './types/repo-intelligence.js';
