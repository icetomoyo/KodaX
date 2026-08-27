/**
 * LLM adapter — bridges the runner-driven AMA chain to the KodaX provider
 * stream surface.
 *
 * Hosts `buildRunnerLlmAdapter` (the per-run factory that returns a
 * `(messages, agent) => RunnerLlmResult` adapter consumed by `Runner.run`)
 * plus the C1-parity helpers (`agentNameToManagedRole`,
 * `flattenNormalizedForEmitterInput`) that drive the fenced-block fallback
 * path. The adapter owns: system-message folding, throttle reminder
 * injection, per-role reasoning ladder resolution, the second-tier
 * retry/recovery loop, max_tokens L4 escalation + L5 continuation, the
 * P2b write-turn cap, cost accounting, iteration events, and tool-call
 * fence-fallback synthesis.
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~1340–2187 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import { randomUUID } from 'node:crypto';

import type {
  KodaXContentBlock,
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXRedactedThinkingBlock,
  KodaXRetryAfterEvent,
  KodaXThinkingBlock,
  KodaXTokenUsage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import {
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
  KodaXProviderError,
  resolvePromptCacheDisabled,
} from '@kodax-ai/llm';
import {
  attachRunnerRecoveryTranscript,
  buildAssistantMessageFromLlmResult,
  type Agent,
  type RunnerLlmResult,
} from '@kodax-ai/agent';
import { resolveProvider } from '../../../providers/index.js';
import {
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_MAX_EMPTY_COMPLETION_RETRIES,
  KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS,
  MANAGED_RUNNER_PANIC_ITERATIONS,
} from '../../../constants.js';
import {
  bucketProviderPayloadSize,
  cleanupIncompleteToolCalls,
  describeTransientProviderRetry,
  emitResilienceDebug,
  estimateProviderPayloadBytes,
  validateAndFixToolHistory,
} from '../../../agent.js';
import {
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  classifyResilienceError,
  resolveResilienceConfig,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from '../../../resilience/index.js';
import { providerResilienceConfigFromTimeouts } from '../../../timeouts.js';
import { waitForRetryDelay } from '../../../retry-handler.js';
import {
  createCostTracker,
  formatCostReport,
  getSummary as getCostSummary,
  recordRetry as recordCostRetry,
  recordUsage as recordCostUsage,
  type CostTracker,
} from '../../../agent-runtime/middleware/cost-tracker.js';
import { countTokens, estimateTokens } from '../../../tokenizer.js';
import {
  createRuntimeContextBudgetSnapshot,
  estimateToolSchemaTokens,
  partitionContextBudgetMessages,
} from '../../../agent-runtime/context-budget.js';
import {
  resolveReasoningMode,
  resolveRoleEffort,
} from '../../../reasoning.js';
import { mapLegacyReasoningModeToEffortIntent } from '@kodax-ai/llm';
import type {
  KodaXEvents,
  KodaXOptions,
  KodaXPromptCacheDiagnosticEvent,
  KodaXReasoningMode,
  KodaXToolExecutionContext,
  KodaXWireReasoningEffort,
} from '../../../types.js';
import { resolveContextTokenCount } from '../../../token-accounting.js';
import {
  applyContextCapacityReserveOverride,
  degradeIrreducibleUserInputs,
  type UserInputDegradationCache,
} from '../../../capacity-recovery.js';
import type { KodaXOutputSegmentMode } from '../../../output-segments.js';
import {
  emitProviderRateLimit,
  emitStreamEnd,
} from '../../../agent-runtime/event-emitter.js';
import {
  emitPromptCacheDiagnosticRequest,
  emitPromptCacheDiagnosticResponse,
  hashProviderVisibleMessages,
  normalizeDiagnosticEnvelope,
} from '../../../agent-runtime/prompt-cache-diagnostics.js';
import { derivePromptCacheAffinityKey } from '../../../agent-runtime/prompt-cache-affinity.js';
import {
  MANAGED_CONTROL_PLANE_MARKERS,
  sanitizeManagedStreamingText,
} from './sanitize.js';
import type { ContextTokenSnapshotRef } from './compaction.js';
import type { TodoStore } from '../../todo-store.js';
import {
  buildTodoReminderText,
  detectAgentTransition,
  resetTodoReminderState,
  shouldFireTodoReminder,
  tickTodoReminder,
  type TodoReminderState,
} from '../../todo-throttle-reminder.js';
import {
  consumeAgentCompletionTodoReminderText,
  consumeTodoDriftReminderText,
  type TodoDriftReminderState,
} from '../../todo-drift-reminder.js';

/**
 * Cumulative token state captured by the LLM adapter across a full
 * runner chain, exposed back to `runManagedTaskViaRunner` so it can
 * populate `result.contextTokenSnapshot`. The REPL UI uses the snapshot
 * to refresh its token counter after every run.
 */
export interface RunnerAdapterTokenState {
  totalTokens: number;
  lastUsage?: KodaXTokenUsage;
  source: 'api' | 'estimate';
}

// FEATURE_193 (v0.7.43) deep V1 cleanup: `agentNameToManagedRole` +
// `flattenNormalizedForEmitterInput` deleted. They were C1-parity helpers
// for the fenced-block fallback path that synthesized a tool call when
// the LLM emitted a `kodax-task-*` block without calling the corresponding
// `emit_*` tool. V1 chain retirement removed every reachable agent name
// (SCOUT/PLANNER/GENERATOR) the mapping recognized, so `agentNameToManagedRole`
// always returned `undefined` and the synthesize block short-circuited
// before either helper ran. The Sidecar Verifier (FEATURE_184) drives
// verdicts out-of-band and does not need the V2 worker to fall through
// to the fence-synthesizer.

/**
 * True when a successfully-returned provider turn carries no public output:
 * no text and no tool calls. Thinking blocks do not count here. Distinct from a
 * stream-incomplete error (which throws before reaching here) and from a
 * canonical text-only termination (text present, no tool — the FEATURE_190
 * V2 exit path). See KODAX_MAX_EMPTY_COMPLETION_RETRIES for why the
 * adapter re-streams instead of returning such a turn to the runner.
 */
function isEmptyCompletion(raw: {
  textBlocks?: readonly { text: string }[];
  toolBlocks?: readonly KodaXToolUseBlock[];
}): boolean {
  const text = (raw.textBlocks ?? []).map((b) => b.text).join('').trim();
  const toolCount = raw.toolBlocks?.length ?? 0;
  return text.length === 0 && toolCount === 0;
}

function managedProviderAbortError(): Error {
  const error = new Error('Managed provider work cancelled by caller.');
  error.name = 'AbortError';
  return error;
}

function throwIfManagedProviderAborted(
  signal: AbortSignal | undefined,
  providerMessages: readonly KodaXMessage[],
): void {
  if (!signal?.aborted) return;
  const error = managedProviderAbortError();
  attachRunnerRecoveryTranscript(error, providerMessages);
  throw error;
}

function rethrowObservedManagedProviderAbort(
  signal: AbortSignal | undefined,
  error: Error,
  providerMessages: readonly KodaXMessage[],
): void {
  if (!signal?.aborted) return;
  attachRunnerRecoveryTranscript(error, providerMessages);
  throw error;
}

async function waitForManagedProviderRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  providerMessages: readonly KodaXMessage[],
): Promise<void> {
  throwIfManagedProviderAborted(signal, providerMessages);
  try {
    await waitForRetryDelay(delayMs, signal);
  } catch (error: unknown) {
    if (signal?.aborted) {
      const abortError = managedProviderAbortError();
      attachRunnerRecoveryTranscript(abortError, providerMessages);
      throw abortError;
    }
    throw error;
  }
  throwIfManagedProviderAborted(signal, providerMessages);
}

function estimateFinalEnvelopeTokens(
  messages: readonly KodaXMessage[],
  tools: readonly KodaXToolDefinition[],
  system: string,
  ephemeralSuffix?: KodaXEphemeralSuffix,
): number {
  const toolSchemaTokens = tools.reduce(
    (total, definition) => total + estimateToolSchemaTokens(definition),
    0,
  );
  return estimateTokens(messages)
    + countTokens(system)
    + toolSchemaTokens
    + countTokens(ephemeralSuffix?.content ?? '');
}

function appendEphemeralSuffixToMessages(
  messages: readonly KodaXMessage[],
  ephemeralSuffix: KodaXEphemeralSuffix | undefined,
): KodaXMessage[] {
  const suffix = ephemeralSuffix?.content;
  if (!suffix) return [...messages];
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    return [
      ...messages,
      {
        role: 'user',
        content: suffix,
        _synthetic: true,
        _source: 'managed-run-context',
      },
    ];
  }
  const content = typeof last.content === 'string'
    ? last.content.length > 0
      ? `${last.content}\n\n${suffix}`
      : suffix
    : [...last.content, { type: 'text' as const, text: suffix }];
  return [...messages.slice(0, -1), { ...last, content }];
}

export { hashProviderVisibleMessages };

/** Resolve the provider reasoning envelope shared by the managed request and
 * its cache-stable compaction request. Keeping this in one function prevents
 * the two payload prefixes from drifting and invalidating provider KV cache. */
export function resolveManagedProviderReasoning(
  options: KodaXOptions,
  agent: Agent,
): KodaXReasoningRequest {
  const userCeiling: KodaXWireReasoningEffort =
    options.effort ?? mapLegacyReasoningModeToEffortIntent(resolveReasoningMode(options));
  const effort = resolveRoleEffort(userCeiling, agent.reasoning);
  return effort === 'none'
    ? { enabled: false, effort: 'none' }
    : { enabled: true, effort };
}

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
    ephemeralSuffix?: KodaXEphemeralSuffix,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
  tokenStateRef?: { current: RunnerAdapterTokenState },
  /**
   * FEATURE_078: optional callback that returns Scout's current
   * `downstream_reasoning_hint` (L3 input). Called once per per-role
   * adapter invocation so the resolver sees the hint as soon as the
   * Scout payload is populated. Returning `undefined` bypasses L3 and
   * falls back to L2 (`agent.reasoning.default`) clamped by L1
   * (user ceiling). The callback closes over the AMA frame's recorder.
   */
  getScoutReasoningHint?: () => KodaXReasoningMode | undefined,
  /**
   * v0.7.40 — optional API-accurate context-size snapshot ref. The
   * adapter writes this ref after each successful LLM stream so the
   * AMA compaction hook (`buildManagedTaskCompactionHook`) can read
   * `usage.totalTokens` + delta-adjusted message growth instead of
   * the transcript-only estimate. Without this wiring, the hook
   * systematically underestimated context by the system + tools
   * schema overhead (~20-35k after FEATURE_114 4→2 role
   * consolidation) and never triggered compaction. See
   * `_internal/managed-task/compaction.ts` for the consumer side.
   */
  contextTokenSnapshotRef?: ContextTokenSnapshotRef,
  /**
   * FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder hook. When
   * provided, the adapter:
   *   1. detects agent transitions and resets the counter on each one
   *   2. checks `shouldFireTodoReminder` before each provider call;
   *      if it fires, appends a synthetic user/context message so the
   *      stable leading system prompt remains cacheable
   *   3. ticks the counter forward (one round = one adapter call)
   * Omitting either argument disables the reminder logic entirely
   * (older callers / unit-test fixtures).
   */
  todoStore?: TodoStore,
  todoReminderState?: TodoReminderState,
  /**
   * Per-run iteration counter holder shared with the idle-yield outer
   * loop. The counter must live in the SAME scope as the Runner's tool
   * loop it reports against: the caller resets `current` to 0 at the top
   * of every `runOnce` (each fresh `Runner.run`), so the value the
   * adapter reports stays aligned with the Runner's per-invocation
   * iteration index even across idle-yield resumes. Omitting it (tests /
   * direct invocations) falls back to a
   * local per-adapter counter — same shape, just not reset across runs.
   */
  iterationStateRef?: { current: number },
  /**
   * Warn-only todo drift nudge. The runner arms this after a successful
   * work tool completes while pending todos exist but no item is active;
   * the adapter consumes it once on the next provider call.
   */
  todoDriftReminderState?: TodoDriftReminderState,
  contextBudgetCatalogs?: {
    readonly skillCatalogText?: string;
    readonly selectedSkillText?: string;
    readonly mcpCatalogText?: string;
    readonly contextWindow?: number;
  },
  /** Volatile request-only context appended after Provider cache breakpoints. */
  getEphemeralSuffix?: () => KodaXEphemeralSuffix | undefined,
  userInputDegradationCache?: UserInputDegradationCache,
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  // FEATURE_072 parity: the REPL's token-count indicator reads
  // `onIterationEnd` to refresh after each worker LLM turn. The iteration
  // index is reported as the `iter` of `onIterationStart`/`onIterationEnd`;
  // `maxIter` reports the real per-Runner mechanical fuse. It is not a
  // cumulative managed-task budget: the caller resets `iterationStateRef`
  // before every fresh idle-yield `runOnce` invocation.
  const localIterationState = { current: 0 };
  const iterationState = iterationStateRef ?? localIterationState;
  const MAX_ITER_HINT = MANAGED_RUNNER_PANIC_ITERATIONS;
  let pendingRuntimeReminders: string[] = [];

  // FEATURE_296 T5/T6 (ADR-067): per-run request-recovery state — the cache
  // of degraded copies for irreducibly oversized fresh user inputs, and the
  // tool-execution context backing the spill artifact.
  const userInputSpillCtx: KodaXToolExecutionContext = { backups: new Map() };

  const requireUserInputDegradationCache = (): UserInputDegradationCache => {
    if (userInputDegradationCache === undefined) {
      throw new Error('Managed LLM adapter requires a run-owned user-input degradation cache.');
    }
    return userInputDegradationCache;
  };

  // Cost tracker — one per session; `recordUsage` is called after every
  // provider.stream usage payload. REPL /cost reads through
  // `events.getCostReport.current`.
  let costTracker: CostTracker = createCostTracker();
  if (options.events?.getCostReport) {
    options.events.getCostReport.current = () =>
      formatCostReport(getCostSummary(costTracker));
  }
  const activeModel = options.modelOverride ?? options.model;

  return async (messages, agent) => {
    // Strip every leading contiguous system message and concatenate their
    // content. v0.7.22-style flows pushed a single agent-instructions system
    // prompt and nothing else, so taking only `messages[0]` was enough. The
    // Runner-driven path stacks [compaction-summary, post-compact-ledger,
    // post-compact-file-content, ...] after compaction+inject, and after a
    // handoff `replaceSystemMessage` only swaps [0] — the rest stay leading
    // system entries. Keeping only the first one would strand agent role
    // instructions (Scout/Planner/Generator/Evaluator) behind the summary and
    // still leak secondary system messages into the transcript, which the
    // provider layer now merges but which would otherwise confuse strict
    // proxies that reject any non-leading system message.
    let cut = 0;
    while (cut < messages.length && messages[cut]?.role === 'system') {
      cut += 1;
    }
    const systemParts: string[] = [];
    for (let i = 0; i < cut; i += 1) {
      const content = messages[i]!.content;
      const text = typeof content === 'string' ? content : '';
      if (text.trim().length > 0) {
        systemParts.push(text);
      }
    }
    const system = systemParts.join('\n\n');
    let transcript = messages.slice(cut);
    const ephemeralSuffix = getEphemeralSuffix?.();
    const runtimeReminders = pendingRuntimeReminders;
    pendingRuntimeReminders = [];
    const injectedInputMessages: KodaXMessage[] = [];

    if (todoStore && todoDriftReminderState) {
      const reminder = consumeTodoDriftReminderText(todoDriftReminderState, todoStore);
      if (reminder) {
        runtimeReminders.push(reminder);
      }
      const completionReminder = consumeAgentCompletionTodoReminderText(
        todoDriftReminderState,
        todoStore,
        transcript,
      );
      if (completionReminder) {
        runtimeReminders.push(completionReminder);
      }
    }

    // FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder. Detect
    // agent transitions to reset the counter (per-task scope, but a
    // role swap is a natural reset point — Scout → Planner → Generator
    // → Evaluator each represent a fresh attempt at making progress on
    // the list). Then, if the threshold has been hit and we're armed,
    // append the reminder as a persisted synthetic input for this exact
    // turn. Finally, tick the counter forward — one adapter call = one round.
    if (todoStore && todoReminderState) {
      if (detectAgentTransition(todoReminderState, agent.name)) {
        resetTodoReminderState(todoReminderState);
      }
      if (shouldFireTodoReminder(todoReminderState, todoStore)) {
        const reminder = buildTodoReminderText(todoStore, todoReminderState.roundsSinceUpdate.current);
        runtimeReminders.push(reminder);
      }
      tickTodoReminder(todoReminderState);
    }

    if (runtimeReminders.length > 0) {
      const reminderAnchor = [...transcript]
        .reverse()
        .find((message) => message.turnId !== undefined || message.timestamp !== undefined);
      const reminderMessage: KodaXMessage = {
        role: 'user',
        content: runtimeReminders.join('\n\n'),
        _synthetic: true,
        _source: 'managed-runtime-reminder',
        turnId: reminderAnchor?.turnId,
        timestamp: reminderAnchor?.timestamp ?? new Date().toISOString(),
      };
      const latest = transcript.at(-1);
      const latestIsRealUserInput = latest?.role === 'user'
        && latest._synthetic !== true
        && (
          typeof latest.content === 'string'
          || latest.content.some((block) => block.type !== 'tool_result')
        );
      if (latestIsRealUserInput) {
        // Runner can only persist injected inputs by appending them. Locally
        // moving this reminder before a new user correction would therefore
        // make the Provider request differ from the authoritative transcript
        // and break the strict prefix on the next call. Defer it to the next
        // append-safe boundary; the user correction remains the newest input.
        pendingRuntimeReminders = runtimeReminders;
      } else {
        injectedInputMessages.push(reminderMessage);
        transcript = [...transcript, reminderMessage];
      }
    }

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? [])
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));

    // Reasoning single-tracking: resolve the per-turn reasoning EFFORT through
    // the FEATURE_078 L1-L2 chain (effort-native):
    //   L1 (user ceiling)  ← options.effort (or legacy reasoningMode mapped)
    //   L2 (agent default) ← agent.reasoning.default + .max (mapped to effort)
    // FEATURE_193 (v0.7.43): V1 chain retired — the Worker is the sole agent,
    // so the per-role split and the Scout hint (L3) are gone.
    const providerReasoning = resolveManagedProviderReasoning(options, agent);

    iterationState.current += 1;
    options.events?.onIterationStart?.(iterationState.current, MAX_ITER_HINT);

    // FEATURE_164 (v0.7.41) — mid-iteration yield retired here.
    //
    // The legacy v0.7.26 F1 parity check used to fire `hasQueuedFollowUp`
    // at this exact boundary and `return { text:'', toolCalls:[] }` to
    // force Runner.run to exit the loop. v0.7.40 FEATURE_159 made it
    // worse by routing the predicate through MessageQueue directly —
    // any user-typed prompt entering the queue mid-Q1 triggered the
    // empty-turn yield, polluting the transcript with `{type:'text',
    // text:''}` placeholder, surfacing `[No response text was produced
    // for this round]` in the REPL, and feeding the model an empty
    // assistant turn before the next user message.
    //
    // Replacement: claudecode-style mid-turn injection via the agent
    // package's `beforeNextTurn` hook (see the Runner.run wiring in
    // `runManagedTaskViaRunnerInner`). The hook drains queued user
    // prompts AFTER tool execution and BEFORE the next LLM call,
    // splicing them as real user messages into the transcript — Worker
    // keeps running, the LLM sees the new prompts in its next turn,
    // and no empty assistant turn ever reaches the transcript.

    let streamResult: {
      textBlocks?: readonly { text: string }[];
      toolBlocks?: readonly KodaXToolUseBlock[];
      thinkingBlocks?: readonly (
        | KodaXThinkingBlock
        | KodaXRedactedThinkingBlock
      )[];
      usage?: KodaXTokenUsage;
    };
    if (overrideStream) {
      streamResult = await overrideStream(
        transcript,
        wireTools,
        system,
        ephemeralSuffix,
      );
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      const providerName = options.provider ?? provider.name ?? 'anthropic';
      const supportsNativeEphemeralSuffix =
        typeof provider.supportsEphemeralSuffix === 'function'
        && provider.supportsEphemeralSuffix();
      const nativeEphemeralSuffix = supportsNativeEphemeralSuffix
        ? ephemeralSuffix
        : undefined;
      const lowerProviderMessages = (
        providerMessages: readonly KodaXMessage[],
      ): KodaXMessage[] => supportsNativeEphemeralSuffix
        ? [...providerMessages]
        : appendEphemeralSuffixToMessages(providerMessages, ephemeralSuffix);
      const diagnosticSessionId = options.context?.contextIdentitySessionId
        ?? options.session?.id;
      const diagnosticAgentId = options.context?.currentAgentId;
      const diagnosticParentAgentId = options.context?.parentAgentId;
      const diagnosticContextId = diagnosticSessionId === undefined
        ? undefined
        : diagnosticAgentId === undefined
          ? diagnosticSessionId
          : `${diagnosticSessionId}/agent/${encodeURIComponent(diagnosticAgentId)}`;
      const diagnosticContextIdentity = {
        ...(diagnosticContextId !== undefined
          ? { contextId: diagnosticContextId }
          : {}),
        contextKind: diagnosticAgentId !== undefined
          ? 'child' as const
          : 'root' as const,
        ...(diagnosticSessionId !== undefined && diagnosticAgentId !== undefined
          ? {
              parentContextId: diagnosticParentAgentId === undefined
                || diagnosticParentAgentId === '/root'
                ? diagnosticSessionId
                : `${diagnosticSessionId}/agent/${encodeURIComponent(diagnosticParentAgentId)}`,
            }
          : {}),
        ...(diagnosticAgentId !== undefined
          ? { agentId: diagnosticAgentId }
          : {}),
      };
      const promptCacheKey = resolvePromptCacheDisabled(options.disablePromptCache)
        ? undefined
        : derivePromptCacheAffinityKey({
            logicalSessionId: diagnosticSessionId,
            ...(diagnosticAgentId !== undefined ? { agentId: diagnosticAgentId } : {}),
          });
      const emitContextBudgetSnapshot = (
        providerMessages: readonly KodaXMessage[],
        requestReservedResponseTokens = provider.getEffectiveMaxOutputTokens(activeModel),
      ): void => {
        if (
          options.context?.contextDiagnostics !== true
          || !options.events?.onContextBudgetSnapshot
        ) {
          return;
        }
        try {
          const diagnosticEnvelope = normalizeDiagnosticEnvelope(system, providerMessages, provider);
          const contextWindow = contextBudgetCatalogs?.contextWindow
            ?? provider.getEffectiveContextWindow(activeModel);
          const turnId = [...diagnosticEnvelope.messages]
            .reverse()
            .find((message) => message.turnId !== undefined)
            ?.turnId;
          const budgetMessages: readonly KodaXMessage[] = ephemeralSuffix?.content
            ? [
                ...diagnosticEnvelope.messages,
                {
                  role: 'user',
                  content: ephemeralSuffix.content,
                  _synthetic: true,
                  _source: 'managed-run-context',
                  ...(turnId !== undefined ? { turnId } : {}),
                },
              ]
            : diagnosticEnvelope.messages;
          const messageTokenBreakdown = partitionContextBudgetMessages(
            budgetMessages,
            {
              skillTexts: [
                contextBudgetCatalogs?.skillCatalogText,
                contextBudgetCatalogs?.selectedSkillText,
              ].filter((value): value is string => value !== undefined),
              mcpTexts: contextBudgetCatalogs?.mcpCatalogText
                ? [contextBudgetCatalogs.mcpCatalogText]
                : [],
            },
          );
          options.events.onContextBudgetSnapshot(createRuntimeContextBudgetSnapshot({
            sessionId: options.session?.id,
            turnId,
            ...diagnosticContextIdentity,
            provider: providerName,
            model: activeModel ?? provider.getModel?.() ?? 'unknown',
            contextWindow,
            systemPrompt: diagnosticEnvelope.system,
            toolDefinitions: wireTools,
            messageTokenBreakdown,
            reservedResponseTokens: requestReservedResponseTokens,
            profile: 'report_only',
          }));
        } catch (error) {
          emitResilienceDebug('[context-diagnostics:budget-error]', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const beginPromptCacheDiagnostic = (
        providerMessages: readonly KodaXMessage[],
        attempt: number,
        transport: 'stream' | 'complete' = 'stream',
      ): KodaXPromptCacheDiagnosticEvent | undefined => {
        return emitPromptCacheDiagnosticRequest({
          events: options.events,
          enabled: options.context?.contextDiagnostics === true,
          provider,
          providerName,
          ...diagnosticContextIdentity,
          model: activeModel ?? provider.getModel?.() ?? 'unknown',
          reasoning: providerReasoning,
          disablePromptCache: options.disablePromptCache,
          system,
          tools: wireTools,
          messages: providerMessages,
          ...(ephemeralSuffix !== undefined ? { ephemeralSuffix } : {}),
          ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
          attempt,
          transport,
        });
      };
      const completePromptCacheDiagnostic = (
        request: KodaXPromptCacheDiagnosticEvent | undefined,
        usage: KodaXTokenUsage | undefined,
      ): void => {
        emitPromptCacheDiagnosticResponse(options.events, request, usage);
      };
      // Shard 6d-P: restore the legacy second-tier retry/recovery loop
      // (agent.ts:1955-2198). Without this, any transient stream error
      // (network/terminated/stream-incomplete/idle-timeout) aborts the
      // whole managed run on the first failure — no retry, no
      // `onProviderRecovery` event, and the REPL's onError handler ends
      // up printing the raw error via console.log which Ink places below
      // the user prompt instead of inline with the worker output.
      //
      // Mirrors the legacy loop: classify → decide → onProviderRecovery →
      // optional non-streaming fallback → executeRecovery (prune
      // incomplete tool_use turns) → waitForRetryDelay → retry.
      const resilienceCfg = resolveResilienceConfig(
        providerName,
        providerResilienceConfigFromTimeouts(options.timeouts),
      );
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs;
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;
      const boundaryTracker = new StableBoundaryTracker();
      const supportsFallback = typeof provider.supportsNonStreamingFallback === 'function'
        ? provider.supportsNonStreamingFallback()
        : false;
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback: resilienceCfg.enableNonStreamingFallback && supportsFallback,
      });
      // P2b write-turn cap retired in v0.7.42. The 2026-04 bench
      // (9622a909) proved RST is time-based on zhipu-coding (308s
      // server kill window), not payload-size-based on any provider —
      // so the correct defense layer is `streamMaxDurationMs` + non-
      // streaming fallback (configured per-provider in registry.ts),
      // not a `max_output_tokens` shrink on the write-turn boundary.
      // The L4 escalation + L5 continuation paths below handle any
      // remaining max_tokens cases regardless of provider.
      let providerMessages: KodaXMessage[] = [...transcript];
      // Clean incomplete tool calls and validate tool history before
      // every provider call (CAP-002). Both helpers come from
      // `agent-runtime/history-cleanup.ts` and are shared with the
      // SA-mode substrate (see catch-terminals.ts:runCatchCleanup).
      providerMessages = cleanupIncompleteToolCalls(providerMessages);
      providerMessages = validateAndFixToolHistory(providerMessages);
      // FEATURE_296 T5/T6 (ADR-067): degrade irreducibly oversized fresh user
      // inputs on the request copy, then shrink the wire-level output reserve
      // while the assembled request is still over capacity so the request
      // the provider receives is legal. The provider stays the authoritative
      // judge; a rejection routes to classification, not a resend.
      const recoveryContextWindow = contextBudgetCatalogs?.contextWindow;
      let requestMaxOutputTokens = provider.getEffectiveMaxOutputTokens(activeModel);
      if (recoveryContextWindow !== undefined) {
        providerMessages = await degradeIrreducibleUserInputs(
          providerMessages,
          userInputSpillCtx,
          recoveryContextWindow,
          requireUserInputDegradationCache(),
        );
        requestMaxOutputTokens = applyContextCapacityReserveOverride(provider, {
          ...(activeModel !== undefined ? { model: activeModel } : {}),
          contextWindow: recoveryContextWindow,
          currentTokens: resolveContextTokenCount(
            providerMessages,
            contextTokenSnapshotRef?.current,
          ),
        });
      }
      let attempt = 0;
      let raw!: Awaited<ReturnType<typeof provider.stream>>;
      // FEATURE_085 parity for the Scout/Runner path: mirror the main
      // agent loop's max_tokens escalation (cd213e4). When a capped-budget
      // turn returns stop_reason:max_tokens we retry the SAME stream call
      // once with KODAX_ESCALATED_MAX_OUTPUT_TOKENS (64K). At most one
      // escalation per adapter invocation — if 64K still hits the cap,
      // we surface the partial result so the Runner's outer loop can see
      // it and decide next steps. Full L5 continuation (meta "break into
      // smaller pieces") is handled by prompt-level guidance in system.ts
      // + write/edit tool descriptions rather than framework plumbing
      // through the Runner turn boundary.
      let hasEscalatedForCurrentAdapterCall = false;
      // Independent budget (separate from the resilience error budget and
      // the max_tokens escalation) for re-streaming a fully-empty turn.
      let emptyCompletionRetries = 0;
      const responseId = [...providerMessages]
        .reverse()
        .find((message) => message.turnId !== undefined)
        ?.turnId ?? `response_${randomUUID().replace(/-/g, '')}`;
      let nextRequestMode: KodaXOutputSegmentMode = 'append';
      while (true) {
        throwIfManagedProviderAborted(options.abortSignal, providerMessages);
        attempt += 1;
        const wireProviderMessages = lowerProviderMessages(providerMessages);
        boundaryTracker.beginRequest(
          providerName,
          activeModel ?? provider.getModel?.() ?? 'unknown',
          wireProviderMessages,
          attempt,
          false,
        );
        const request = boundaryTracker.snapshot();
        telemetryBoundary(request);
        const requestMeta = { providerRequestId: request.requestId } as const;
        options.events?.onOutputSegmentStart?.(
          { responseId, providerRequestId: request.requestId, mode: nextRequestMode },
          requestMeta,
        );

        const retryTimeoutController = new AbortController();
        let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          retryTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
        }, API_HARD_TIMEOUT_MS);
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(
              new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
            );
          }, API_IDLE_TIMEOUT_MS);
        }
        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          if (idleTimer) clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(
                new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
              );
            }, API_IDLE_TIMEOUT_MS);
          }
        };
        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, system)
          + Buffer.byteLength(ephemeralSuffix?.content ?? '', 'utf8');
        emitResilienceDebug('[resilience:request]', {
          provider: providerName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
        });

        // Wire the boundary tracker into the stream callbacks — the
        // coordinator inspects these markers to decide whether a failure
        // happened before the first delta, mid-stream, post-tool, etc.
        const streamOptions = {
          promptCacheKey,
          modelOverride: activeModel,
          maxOutputTokensOverride: requestMaxOutputTokens,
          ephemeralSuffix: nativeEphemeralSuffix,
          onTextDelta: (text: string) => {
            boundaryTracker.markTextDelta(text);
            resetIdleTimer();
            // M2 parity (v0.7.26) — scrub managed control-plane markers
            // and incomplete managed fences from the streamed delta
            // before surfacing to `events.onTextDelta`. Without this,
            // mid-turn `[managed-task] ...` / `<scout_verdict>` tags
            // briefly appear in REPL live output even though they're
            // stripped from the final turn text. Matches legacy
            // behaviour where managed-worker streams routed through
            // `sanitizeManagedStreamingText` before the REPL saw them.
            // The sanitize call trims — only apply it when we actually
            // detect a marker in this delta to preserve mid-token
            // whitespace in the common clean-delta case.
            const hasMarker = text.includes('```')
              || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
            const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
            if (outText.length === 0) return;
            options.events?.onTextDelta?.(outText, requestMeta);
          },
          onThinkingDelta: (text: string) => {
            boundaryTracker.markThinkingDelta(text);
            resetIdleTimer();
            options.events?.onThinkingDelta?.(text, requestMeta);
          },
          onThinkingEnd: (thinking: string) => {
            options.events?.onThinkingEnd?.(thinking, requestMeta);
          },
          onToolInputDelta: options.events?.onToolInputDelta,
          onRateLimit: (rateAttempt: number, maxRetries: number, delayMs: number) => {
            resetIdleTimer();
            if (options.events) {
              emitProviderRateLimit(options.events, rateAttempt, maxRetries, delayMs);
            }
          },
          onRetryAfter: (event: KodaXRetryAfterEvent) => {
            resetIdleTimer();
            costTracker = recordCostRetry(costTracker, {
              provider: event.provider,
              waitMs: event.waitMs,
              reason: event.reason,
              source: event.source,
            });
            options.events?.onRetryAfter?.(event);
          },
        };

        try {
          emitContextBudgetSnapshot(providerMessages, requestMaxOutputTokens);
          const cacheDiagnostic = beginPromptCacheDiagnostic(providerMessages, attempt);
          raw = await provider.stream(
            wireProviderMessages,
            [...wireTools],
            system,
            providerReasoning,
            streamOptions,
            retrySignal,
          );
          completePromptCacheDiagnostic(cacheDiagnostic, raw.usage);
          // max_tokens escalation: if the capped budget hit the cap and
          // we haven't yet escalated this adapter call, stage
          // KODAX_ESCALATED_MAX_OUTPUT_TOKENS for the next iteration and
          // re-enter the loop. Skipped when the user explicitly set
          // KODAX_MAX_OUTPUT_TOKENS or the effective budget already meets
          // the escalated threshold. Mirrors agent.ts:2264-2284.
          if (
            raw.stopReason === 'max_tokens'
            && !hasEscalatedForCurrentAdapterCall
            && !process.env.KODAX_MAX_OUTPUT_TOKENS
            && requestMaxOutputTokens < KODAX_ESCALATED_MAX_OUTPUT_TOKENS
          ) {
            throwIfManagedProviderAborted(options.abortSignal, providerMessages);
            hasEscalatedForCurrentAdapterCall = true;
            requestMaxOutputTokens = KODAX_ESCALATED_MAX_OUTPUT_TOKENS;
            // FEATURE_296 T6 (ADR-067): the escalation must not blanket the
            // capacity floor-shrink — on a squeezed window 64K would re-issue
            // an illegal request. Re-clamp to the floor-bounded reserve.
            if (recoveryContextWindow !== undefined) {
              requestMaxOutputTokens = applyContextCapacityReserveOverride(provider, {
                ...(activeModel !== undefined ? { model: activeModel } : {}),
                maxOutputTokens: requestMaxOutputTokens,
                contextWindow: recoveryContextWindow,
                currentTokens: resolveContextTokenCount(
                  providerMessages,
                  contextTokenSnapshotRef?.current,
                ),
              });
            }
            options.events?.onRetry?.(
              `Output budget reached, escalating to ${KODAX_ESCALATED_MAX_OUTPUT_TOKENS} tokens and retrying the same turn`,
              1,
              1,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Escalation is a same-turn re-issue (change max_tokens, replay same messages),
            // not an error recovery. Reverse the `attempt += 1` at the top of the loop so
            // this iteration does not consume a slot from `resilienceCfg.maxRetries`. The
            // next iteration's attempt will be the same as this one, and subsequent real
            // errors still get the full retry budget.
            attempt -= 1;
            nextRequestMode = 'replace';
            continue;
          }
          // Empty-completion retry: a finish_reason-complete turn with no
          // public text and no tool calls is a degraded response
          // (common on budget OpenAI-compat providers under load / right
          // after a 429). Handing it back would hit the runner's no-tool
          // terminal branch and end the task silently. Re-stream the same
          // turn a bounded number of times. Mirrors the L1 escalation's
          // `attempt -= 1` so this does not consume the resilience error
          // budget. Timers are cleared before the backoff await so the
          // idle/hard timeout cannot abort the controller mid-wait. A
          // genuine text-only termination (text present) is untouched, and
          // the `max_tokens` stop reason is excluded so the escalation + L5
          // ladder above keeps sole ownership of that path.
          if (
            isEmptyCompletion(raw)
            && raw.stopReason !== 'max_tokens'
            && emptyCompletionRetries < KODAX_MAX_EMPTY_COMPLETION_RETRIES
            && !options.abortSignal?.aborted
          ) {
            emptyCompletionRetries += 1;
            options.events?.onRetry?.(
              `Provider returned an empty turn, retrying ${emptyCompletionRetries}/${KODAX_MAX_EMPTY_COMPLETION_RETRIES}`,
              emptyCompletionRetries,
              KODAX_MAX_EMPTY_COMPLETION_RETRIES,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            attempt -= 1;
            nextRequestMode = 'replace';
            await waitForManagedProviderRetry(
              KODAX_EMPTY_COMPLETION_RETRY_BASE_DELAY_MS * emptyCompletionRetries,
              options.abortSignal,
              providerMessages,
            );
            continue;
          }
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (
            error.name === 'AbortError'
              && retryTimeoutController.signal.aborted
              && !options.abortSignal?.aborted
          ) {
            const reason = (retryTimeoutController.signal as { reason?: { message?: string } })
              .reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax-ai/llm');
            error = new KodaXNetworkError(reason, true);
          }
          rethrowObservedManagedProviderAbort(
            options.abortSignal,
            error,
            providerMessages,
          );

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          options.events?.onProviderRecovery?.({
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
          // Dedicated rate-limit event so REPL can render a distinct 429
          // banner (separate from the generic retry UI).
          if (decision.reasonCode === 'rate_limit' && options.events) {
            emitProviderRateLimit(
              options.events,
              attempt,
              resilienceCfg.maxRetries,
              decision.delayMs,
            );
          }
          if (!options.events?.onProviderRecovery && decision.action !== 'manual_continue') {
            options.events?.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming && typeof provider.complete === 'function') {
            throwIfManagedProviderAborted(options.abortSignal, providerMessages);
            const fallbackTimeoutController = new AbortController();
            const fallbackSignal = options.abortSignal
              ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
              : fallbackTimeoutController.signal;
            const fallbackHardTimer = setTimeout(() => {
              fallbackTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
            }, API_HARD_TIMEOUT_MS);
            try {
              if (idleTimer) clearTimeout(idleTimer);
              if (hardTimer) clearTimeout(hardTimer);
              hardTimer = undefined;
              idleTimer = undefined;
              const wireFallbackMessages = lowerProviderMessages(providerMessages);
              boundaryTracker.beginRequest(
                providerName,
                activeModel ?? provider.getModel?.() ?? 'unknown',
                wireFallbackMessages,
                attempt,
                true,
              );
              const fallbackRequest = boundaryTracker.snapshot();
              telemetryBoundary(fallbackRequest);
              const fallbackMeta = {
                providerRequestId: fallbackRequest.requestId,
              } as const;
              options.events?.onOutputSegmentStart?.(
                { responseId, providerRequestId: fallbackRequest.requestId, mode: 'replace' },
                fallbackMeta,
              );
              emitContextBudgetSnapshot(providerMessages, requestMaxOutputTokens);
              const fallbackCacheDiagnostic = beginPromptCacheDiagnostic(
                providerMessages,
                attempt,
                'complete',
              );
              raw = await provider.complete(
                wireFallbackMessages,
                [...wireTools],
                system,
                providerReasoning,
                {
                  promptCacheKey,
                  modelOverride: activeModel,
                  maxOutputTokensOverride: requestMaxOutputTokens,
                  ephemeralSuffix: nativeEphemeralSuffix,
                  onTextDelta: (text: string) => {
                    boundaryTracker.markTextDelta(text);
                    options.events?.onTextDelta?.(text, fallbackMeta);
                  },
                  onThinkingDelta: (text: string) => {
                    boundaryTracker.markThinkingDelta(text);
                    options.events?.onThinkingDelta?.(text, fallbackMeta);
                  },
                  onThinkingEnd: (thinking: string) => {
                    options.events?.onThinkingEnd?.(thinking, fallbackMeta);
                  },
                  signal: fallbackSignal,
                },
                fallbackSignal,
              );
              completePromptCacheDiagnostic(fallbackCacheDiagnostic, raw.usage);
              break;
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
              rethrowObservedManagedProviderAbort(
                options.abortSignal,
                error,
                providerMessages,
              );
            } finally {
              clearTimeout(fallbackHardTimer);
            }
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) and must
          // bypass the regular retry-budget gate. It's gated by its own
          // `thinkingSanitizationUsed` latch inside the coordinator, so
          // it can fire at most once per request chain regardless of how
          // many normal retries already happened. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Don't bill an attempt slot for the sanitize step — same
            // rationale as the L1 escalation reversal at line ~2546.
            attempt -= 1;
            nextRequestMode = 'replace';
            await waitForManagedProviderRetry(
              decision.delayMs,
              options.abortSignal,
              providerMessages,
            );
            continue;
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            // Preserve in-flight providerMessages on the thrown error so the
            // outer wrapper's session-snapshot save can persist real history
            // instead of `[]`. Non-enumerable so JSON-serializing telemetry
            // does not dump conversation history into logs. The outer catch
            // uses Array.isArray as a guard.
            attachRunnerRecoveryTranscript(error, providerMessages);
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;
          nextRequestMode = 'replace';

          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          hardTimer = undefined;
          idleTimer = undefined;
          await waitForManagedProviderRetry(
            decision.delayMs,
            options.abortSignal,
            providerMessages,
          );
          continue;
        } finally {
          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      // Refuse no-public-output turns after all same-turn recovery attempts;
      // returning one would commit an empty assistant turn into the runner
      // transcript.
      if (isEmptyCompletion(raw)) {
        const error = new KodaXProviderError(
          'Provider returned no user-visible text or tool calls after recovery attempts; refusing to commit an empty assistant turn.',
          providerName,
        );
        attachRunnerRecoveryTranscript(error, providerMessages);
        throw error;
      }

      // M6 parity (v0.7.26) — L5 continuation ladder. When escalation is
      // exhausted and the model still hit max_tokens mid-text (no
      // tool blocks, has text), inject a synthetic user "Continue from
      // where you left off" message and re-stream up to
      // KODAX_MAX_MAXTOKENS_RETRIES times, accumulating text +
      // thinkingBlocks across turns. Mirrors legacy agent.ts:2316-2334.
      // Without this, long Generator replies that blow through the
      // escalated 64K cap get truncated silently — the assistant stops
      // mid-sentence and the Runner exits with a partial answer.
      let l5Retries = 0;
      let accumulatedText = (raw.textBlocks ?? []).map((b) => b.text).join('');
      type ThinkingBlock = KodaXThinkingBlock | KodaXRedactedThinkingBlock;
      const accumulatedThinking: ThinkingBlock[] | undefined = raw.thinkingBlocks
        ? [...raw.thinkingBlocks]
        : undefined;
      while (
        raw.stopReason === 'max_tokens'
        && (raw.toolBlocks?.length ?? 0) === 0
        && accumulatedText.trim().length > 0
        && l5Retries < KODAX_MAX_MAXTOKENS_RETRIES
      ) {
        throwIfManagedProviderAborted(options.abortSignal, providerMessages);
        l5Retries += 1;
        // Push the partial assistant turn + synthetic user continuation
        // onto the outgoing transcript. The provider will see the full
        // mid-thought state and pick up seamlessly.
        //
        // Thinking blocks accumulated so far must ride along on the
        // synthetic assistant turn. Without them, providers in strict
        // thinking-mode (deepseek V4) reject the next replay with
        // "reasoning_content must be passed back to the API" — the
        // synthetic turn would be a thinking-less assistant message in
        // a thinking-enabled request, which violates their per-turn
        // contract. Mirrors what agent.ts:2294 does for the legacy
        // path: thinking + text + tool_use stack on the assistant
        // message in history.
        const assistantContent: KodaXContentBlock[] = [
          ...(accumulatedThinking ?? []),
          { type: 'text', text: accumulatedText },
        ];
        providerMessages = [
          ...providerMessages,
          { role: 'assistant', content: assistantContent } as KodaXMessage,
          {
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. '
                + 'Pick up mid-thought if that is where the cut happened. '
                + 'Break remaining work into smaller pieces.',
            }],
          } as KodaXMessage,
        ];
        options.events?.onRetry?.(
          `max_tokens mid-text, appending continuation ${l5Retries}/${KODAX_MAX_MAXTOKENS_RETRIES}`,
          l5Retries,
          KODAX_MAX_MAXTOKENS_RETRIES,
        );
        const l5Signal = options.abortSignal ?? undefined;
        let continuationText = '';
        try {
          const wireContinuationMessages = lowerProviderMessages(providerMessages);
          boundaryTracker.beginRequest(
            providerName,
            activeModel ?? provider.getModel?.() ?? 'unknown',
            wireContinuationMessages,
            attempt + l5Retries,
            false,
          );
          const continuationRequest = boundaryTracker.snapshot();
          telemetryBoundary(continuationRequest);
          const continuationMeta = {
            providerRequestId: continuationRequest.requestId,
          } as const;
          options.events?.onOutputSegmentStart?.(
            { responseId, providerRequestId: continuationRequest.requestId, mode: 'append' },
            continuationMeta,
          );
          emitContextBudgetSnapshot(providerMessages, requestMaxOutputTokens);
          const cacheDiagnostic = beginPromptCacheDiagnostic(
            providerMessages,
            attempt + l5Retries,
          );
          raw = await provider.stream(
            wireContinuationMessages,
            [...wireTools],
            system,
            providerReasoning,
            {
              promptCacheKey,
              modelOverride: activeModel,
              maxOutputTokensOverride: requestMaxOutputTokens,
              ephemeralSuffix: nativeEphemeralSuffix,
              onTextDelta: (text: string) => {
                const hasMarker = text.includes('```')
                  || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
                const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
                if (outText.length === 0) return;
                continuationText += outText;
                boundaryTracker.markTextDelta(text);
                options.events?.onTextDelta?.(outText, continuationMeta);
              },
              onThinkingDelta: (text: string) => {
                boundaryTracker.markThinkingDelta(text);
                options.events?.onThinkingDelta?.(text, continuationMeta);
              },
              onThinkingEnd: (thinking: string) => {
                options.events?.onThinkingEnd?.(thinking, continuationMeta);
              },
              onToolInputDelta: options.events?.onToolInputDelta,
              onRateLimit: (rateAttempt: number, maxRetries: number, delayMs: number) => {
                if (options.events) {
                  emitProviderRateLimit(options.events, rateAttempt, maxRetries, delayMs);
                }
              },
              onRetryAfter: (event: KodaXRetryAfterEvent) => {
                costTracker = recordCostRetry(costTracker, {
                  provider: event.provider,
                  waitMs: event.waitMs,
                  reason: event.reason,
                  source: event.source,
                });
                options.events?.onRetryAfter?.(event);
              },
            },
            l5Signal,
          );
          completePromptCacheDiagnostic(cacheDiagnostic, raw.usage);
        } catch (error: unknown) {
          rethrowObservedManagedProviderAbort(
            options.abortSignal,
            error instanceof Error ? error : new Error(String(error)),
            providerMessages,
          );
          // L5 retries are best-effort — any failure here falls back to
          // the partial result we already have.
          accumulatedText += continuationText;
          break;
        }
        const nextText = (raw.textBlocks ?? []).map((b) => b.text).join('');
        if (nextText) accumulatedText += nextText;
        if (raw.thinkingBlocks && accumulatedThinking) {
          accumulatedThinking.push(...raw.thinkingBlocks);
        }
        // Exit early on tool calls or natural stop.
        if ((raw.toolBlocks?.length ?? 0) > 0 || raw.stopReason !== 'max_tokens') {
          break;
        }
      }

      streamResult = {
        textBlocks: accumulatedText ? [{ text: accumulatedText }] : raw.textBlocks,
        toolBlocks: raw.toolBlocks,
        thinkingBlocks: accumulatedThinking ?? raw.thinkingBlocks,
        usage: raw.usage,
      };
    }

    // Update cumulative token state for the final contextTokenSnapshot.
    if (tokenStateRef && streamResult.usage) {
      const current = tokenStateRef.current;
      tokenStateRef.current = {
        totalTokens: streamResult.usage.totalTokens ?? current.totalTokens,
        lastUsage: streamResult.usage,
        source: 'api',
      };
    }

    // Record turn usage into the cost tracker so `/cost` reflects AMA spend.
    if (streamResult.usage) {
      const providerName = options.provider ?? 'anthropic';
      costTracker = recordCostUsage(costTracker, {
        provider: providerName,
        model: options.modelOverride ?? options.model ?? 'unknown',
        inputTokens: streamResult.usage.inputTokens,
        outputTokens: streamResult.usage.outputTokens,
        cacheReadTokens: streamResult.usage.cachedReadTokens,
        cacheWriteTokens: streamResult.usage.cachedWriteTokens,
      });
    }

    // onStreamEnd fires after the provider finishes the current turn's
    // stream. The Runner-driven adapter funnels every turn through this
    // single return-path so the event fires once per stream.
    if (options.events) emitStreamEnd(options.events);

    // Fire onIterationEnd so the REPL token-count indicator can refresh
    // after each worker turn. `scope: 'worker'` mirrors the FEATURE_072
    // tagging — every Runner-driven iteration runs inside a worker role,
    // never the top-level REPL agent.
    if (options.events?.onIterationEnd) {
      const usage = streamResult.usage;
      const tokenCount = usage?.totalTokens ?? usage?.outputTokens ?? 0;
      options.events.onIterationEnd({
        iter: iterationState.current,
        maxIter: MAX_ITER_HINT,
        tokenCount,
        tokenSource: usage ? 'api' : 'estimate',
        usage,
        scope: 'worker',
      });
    }

    const text = (streamResult.textBlocks ?? []).map((b) => b.text).join('');
    const toolCalls = (streamResult.toolBlocks ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    }));

    // FEATURE_193 (v0.7.43) deep V1 cleanup: the C1-parity fenced-block
    // fallback (synthesize tool_call when LLM emits a `kodax-task-*` block
    // without calling the matching `emit_*` tool) used to live here. With
    // V1 chain retired, only `'evaluator'` (Sidecar Verifier) remains as
    // a valid emit role, and verdicts are driven out-of-band by Sidecar
    // Verifier — the Worker's terminal turn never needs the fence-to-
    // tool-call synthesis. `agentNameToManagedRole` only matched the V1
    // SCOUT/PLANNER/GENERATOR agent names, so the entire branch was a
    // dead short-circuit in V2 production.

    // Forward thinking blocks so
    // `buildAssistantMessageFromLlmResult` can prepend them to the
    // assistant content. Required for Anthropic extended thinking —
    // provider returns 400 if prior assistant turns with tool_use are
    // missing the thinking block in history.
    const thinkingBlocks = streamResult.thinkingBlocks;
    const runnerResult: RunnerLlmResult = {
      text,
      toolCalls,
      thinkingBlocks,
      injectedInputMessages,
    };

    // Anchor the API total to the same completed assistant transcript Runner
    // appends. Future tool-result growth is then counted exactly once by
    // `resolveContextTokenCount`; cached input remains included in apiTotal.
    if (contextTokenSnapshotRef) {
      const completedRunnerTranscript = [
        ...messages,
        ...injectedInputMessages,
        buildAssistantMessageFromLlmResult(runnerResult),
      ] as KodaXMessage[];
      const apiTotal = streamResult.usage?.totalTokens;
      if (typeof apiTotal === 'number' && Number.isFinite(apiTotal) && apiTotal >= 0) {
        contextTokenSnapshotRef.current = {
          currentTokens: apiTotal,
          baselineEstimatedTokens: estimateTokens(completedRunnerTranscript),
          source: 'api',
          usage: streamResult.usage,
        };
      } else {
        const completedProviderTranscript = [
          ...transcript,
          buildAssistantMessageFromLlmResult(runnerResult),
        ] as KodaXMessage[];
        contextTokenSnapshotRef.current = {
          currentTokens: estimateFinalEnvelopeTokens(
            completedProviderTranscript,
            wireTools,
            system,
            ephemeralSuffix,
          ),
          baselineEstimatedTokens: estimateTokens(completedRunnerTranscript),
          source: 'estimate',
        };
      }
    }
    return runnerResult;
  };
}
