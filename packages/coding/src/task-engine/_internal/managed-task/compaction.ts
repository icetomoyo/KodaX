/** Capacity-driven semantic history compaction for Runner-managed tasks. */

import {
  buildFileContentMessages,
  buildPostCompactAttachments,
  ContextCapacityError,
  compact as intelligentCompact,
  DEFAULT_POST_COMPACT_CONFIG,
  calculateMaxContextInputTokens,
  emitKodaXDiagnostic,
  exceedsContextCapacity,
  injectPostCompactAttachments,
  needsCompaction,
  POST_COMPACT_TOKEN_BUDGET,
  reclaimReservedResponseTokens,
  resolveContextWindow,
  resolveCompactionPolicy,
  type AgentMessage,
  type CompactionConfig,
  type CompactionResult,
  type CompactionUpdate,
} from '@kodax-ai/agent';
import {
  resolvePromptCacheDisabled,
  type KodaXReasoningRequest,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';

import { resolveProvider } from '../../../providers/index.js';
import { loadCompactionConfig } from '../../../compaction-config.js';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from '../../../agent-runtime/coding-compaction-prompts.js';
import type {
  KodaXContextTokenSnapshot,
  KodaXCompactionEndResult,
  KodaXCompactionEndState,
  KodaXMessage,
  KodaXOptions,
} from '../../../types.js';
import { countTokens, estimateTokens } from '../../../tokenizer.js';
import { resolveContextTokenCount } from '../../../token-accounting.js';
import { estimateToolSchemaTokens } from '../../../agent-runtime/context-budget.js';
import { createCompactionPromptCacheObserver } from '../../../agent-runtime/prompt-cache-diagnostics.js';
import { derivePromptCacheAffinityKey } from '../../../agent-runtime/prompt-cache-affinity.js';
import {
  installCanonicalManagedRunContext,
  stripManagedRunContextMessages,
} from './managed-run-context.js';
import {
  consumeCompactionCooldown,
  createCompactionAntiThrashState,
  recordCompactionSavings,
  shouldSkipLlmCompaction,
  type CompactionAntiThrashState,
  type CompactionSkipReason,
} from '../../../agent-runtime/middleware/compaction-pressure.js';

const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;
const COMPACT_FAILURE_COOLDOWN_TURNS = 2;

export type RunnerCompactionHook = (
  transcript: readonly AgentMessage[],
) => Promise<readonly AgentMessage[] | undefined>;

export interface ContextTokenSnapshotRef {
  current: KodaXContextTokenSnapshot | undefined;
}

export interface BuildManagedTaskCompactionHookOptions {
  readonly resolvedContextCapacity?: Awaited<
    ReturnType<typeof resolveManagedTaskContextCapacity>
  >;
  readonly contextTokenSnapshotRef?: ContextTokenSnapshotRef;
  readonly activeToolDefinitions?: readonly KodaXToolDefinition[];
  /** Exact reasoning envelope used by the managed provider request. */
  readonly reasoning?: KodaXReasoningRequest;
  readonly onPostCompact?: () => void;
  /** Fresh canonical run context to reinstall outside semantic summaries. */
  readonly canonicalManagedContext?: () => KodaXMessage | undefined;
}

interface AttachedCompactionContext {
  readonly messages: KodaXMessage[];
  readonly postCompactAttachments?: readonly KodaXMessage[];
}

interface SummaryCircuitBreaker {
  readonly consecutiveFailures: number;
  readonly cooldownTurnsRemaining: number;
  readonly rearmAtTokens?: number;
}

interface ManagedCompactionInput {
  readonly immutableSystem?: KodaXMessage;
  readonly compactableMessages: KodaXMessage[];
  readonly fixedOverheadTokens: number;
  readonly compactableCurrentTokens: number;
}

interface ManagedCompactionAttempt extends ManagedCompactionInput {
  readonly messages: KodaXMessage[];
  readonly currentTokens: number;
  readonly hardPressure: boolean;
}

interface ManagedCompactionState {
  breaker: SummaryCircuitBreaker;
  antiThrash: CompactionAntiThrashState;
}

interface CompactionDiagnosticIdentity {
  readonly contextId?: string;
  readonly contextKind: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
}

type ManagedCompactionAdmission =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'skipped';
      readonly attempt: ManagedCompactionAttempt;
      readonly reason: CompactionSkipReason;
      readonly cooldownTurnsRemaining: number;
      readonly rearmAtTokens?: number;
    }
  | { readonly kind: 'admitted'; readonly attempt: ManagedCompactionAttempt };

interface ManagedCompactionCandidate {
  readonly finalMessages: KodaXMessage[];
  readonly finalTokens: number;
  readonly finalCompactableTokens: number;
  readonly update: CompactionUpdate;
  /**
   * FEATURE_296 (ADR-067): the compacted transcript exceeds the physical
   * next-request budget even at the floor-bounded shrunk reserve (T3). It is
   * committed best-effort (no larger than the pre-compaction transcript) and
   * the recovery ladder owns the next request instead of aborting the run.
   */
  readonly stillOverCapacity?: boolean;
}

type PersistenceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

/** Shared provider/model/window resolution for compaction and result admission. */
export async function resolveManagedTaskContextCapacity(options: KodaXOptions) {
  const provider = resolveProvider(options.provider ?? 'anthropic');
  const activeModel = options.modelOverride ?? options.model;
  const providerWindow = provider.getEffectiveContextWindow?.(activeModel)
    ?? provider.getContextWindow();
  const compactionConfig: CompactionConfig = await loadCompactionConfig(
    providerWindow,
    options.compaction,
  );
  const contextWindow = resolveContextWindow(compactionConfig, provider, activeModel);
  return { provider, activeModel, compactionConfig, contextWindow };
}

async function attachManagedCompactionContext(
  result: CompactionResult,
  fixedOverheadTokens: number,
  contextWindow: number,
  reservedResponseTokens: number,
): Promise<AttachedCompactionContext> {
  if (!result.artifactLedger?.length) {
    return { messages: result.messages };
  }
  const freedTokens = Math.max(0, result.tokensBefore - result.tokensAfter);
  const attachments = buildPostCompactAttachments(result.artifactLedger, freedTokens);
  const attachmentBudget = Math.min(
    Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
    POST_COMPACT_TOKEN_BUDGET,
  );
  const fileBudget = Math.max(0, attachmentBudget - attachments.totalTokens);
  const fileMessages = fileBudget > 0
    ? await buildFileContentMessages(result.artifactLedger, fileBudget)
    : [];
  const fullAttachments = {
    ...attachments,
    fileMessages,
    totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
  };
  if (fullAttachments.totalTokens <= 0) {
    return { messages: result.messages };
  }
  const messages = injectPostCompactAttachments(result.messages, fullAttachments);
  if (exceedsContextCapacity({
    contextWindow,
    currentTokens: fixedOverheadTokens + estimateTokens(messages),
    reservedResponseTokens,
  })) {
    return { messages: result.messages };
  }
  return {
    messages,
    postCompactAttachments: [
      ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
      ...fullAttachments.fileMessages,
    ],
  };
}

function buildCompactionUpdate(
  result: CompactionResult,
  tokensAfter: number,
  preCompactionMessages: readonly KodaXMessage[],
  postCompactAttachments?: readonly KodaXMessage[],
): CompactionUpdate {
  return {
    preCompactionMessages,
    anchor: result.anchor
      ? { ...result.anchor, tokensAfter }
      : undefined,
    artifactLedger: result.artifactLedger,
    memorySeed: result.memorySeed,
    postCompactAttachments,
    report: result.report,
  };
}

function notifyPostCompact(callback: (() => void) | undefined): void {
  notifyCompactionObserver(callback, 'Post-compaction callback failed.');
}

function notifyCompactionObserver(
  callback: (() => void) | undefined,
  message: string,
): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding:managed-compaction',
      level: 'warn',
      message,
      detail: error,
    });
  }
}

function nextRearmTokenCount(currentTokens: number): number {
  return currentTokens + Math.max(2_048, Math.ceil(currentTokens * 0.1));
}

function createSummaryCircuitBreaker(): SummaryCircuitBreaker {
  return { consecutiveFailures: 0, cooldownTurnsRemaining: 0 };
}

function recordSummaryCircuitFailure(
  state: SummaryCircuitBreaker,
  compactableTokens: number,
): SummaryCircuitBreaker {
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures < COMPACT_CIRCUIT_BREAKER_LIMIT) {
    return { ...state, consecutiveFailures };
  }
  return {
    consecutiveFailures,
    cooldownTurnsRemaining: COMPACT_FAILURE_COOLDOWN_TURNS,
    rearmAtTokens: nextRearmTokenCount(compactableTokens),
  };
}

function compactionEndState(
  currentTokens: number,
  compactableTokens: number,
  breaker: SummaryCircuitBreaker,
): KodaXCompactionEndState {
  return {
    currentTokens,
    compactableTokens,
    consecutiveFailures: breaker.consecutiveFailures,
    circuitBreakerLimit: COMPACT_CIRCUIT_BREAKER_LIMIT,
    circuitBreakerState: breaker.consecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT
      ? (breaker.cooldownTurnsRemaining > 0 ? 'open' as const : 'half_open' as const)
      : 'closed' as const,
    cooldownTurnsRemaining: breaker.cooldownTurnsRemaining,
  };
}

function updateSnapshot(
  ref: ContextTokenSnapshotRef | undefined,
  messages: KodaXMessage[],
  currentTokens: number,
): void {
  if (!ref) return;
  ref.current = {
    currentTokens,
    baselineEstimatedTokens: estimateTokens(messages),
    source: ref.current?.source ?? 'estimate',
    usage: ref.current?.usage,
  };
}

function initializeEnvelopeEstimate(
  ref: ContextTokenSnapshotRef | undefined,
  messages: KodaXMessage[],
  toolDefinitions: readonly KodaXToolDefinition[],
): KodaXContextTokenSnapshot | undefined {
  if (ref?.current) return ref.current;
  const baselineEstimatedTokens = estimateTokens(messages);
  let leadingSystemCount = 0;
  const systemParts: string[] = [];
  while (messages[leadingSystemCount]?.role === 'system') {
    const content = messages[leadingSystemCount]!.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      systemParts.push(content);
    }
    leadingSystemCount += 1;
  }
  const toolSchemaTokens = toolDefinitions.reduce(
    (total, definition) => total + estimateToolSchemaTokens(definition),
    0,
  );
  const snapshot: KodaXContextTokenSnapshot = {
    currentTokens: estimateTokens(messages.slice(leadingSystemCount))
      + countTokens(systemParts.join('\n\n'))
      + toolSchemaTokens,
    baselineEstimatedTokens,
    source: 'estimate',
  };
  if (ref) ref.current = snapshot;
  return snapshot;
}

function splitImmutableSystem(messages: KodaXMessage[]): {
  readonly immutableSystem?: KodaXMessage;
  readonly mutableMessages: KodaXMessage[];
} {
  const first = messages[0];
  if (first?.role !== 'system') return { mutableMessages: messages };
  return {
    immutableSystem: first,
    mutableMessages: messages.slice(1),
  };
}

function prependImmutableSystem(
  immutableSystem: KodaXMessage | undefined,
  messages: KodaXMessage[],
): KodaXMessage[] {
  return immutableSystem ? [immutableSystem, ...messages] : messages;
}

function resolveManagedCompactionInput(
  messages: KodaXMessage[],
  currentTokens: number,
  stripManagedContext: boolean,
): ManagedCompactionInput {
  const { immutableSystem, mutableMessages } = splitImmutableSystem(messages);
  const compactableMessages = stripManagedContext
    ? stripManagedRunContextMessages(mutableMessages)
    : mutableMessages;
  const fixedOverheadTokens = Math.max(0, currentTokens - estimateTokens(mutableMessages));
  return {
    immutableSystem,
    compactableMessages,
    fixedOverheadTokens,
    compactableCurrentTokens: stripManagedContext
      ? fixedOverheadTokens + estimateTokens(compactableMessages)
      : currentTokens,
  };
}

function admitManagedCompactionAttempt(input: {
  readonly messages: KodaXMessage[];
  readonly currentTokens: number;
  readonly compactionConfig: CompactionConfig;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly stripManagedContext: boolean;
  readonly state: ManagedCompactionState;
}): ManagedCompactionAdmission {
  if (!needsCompaction(
    input.messages,
    input.compactionConfig,
    input.contextWindow,
    input.currentTokens,
    input.reservedResponseTokens,
  )) return { kind: 'none' };

  const hardPressure = exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: input.currentTokens,
    reservedResponseTokens: input.reservedResponseTokens,
  });
  const compactable = resolveManagedCompactionInput(
    input.messages,
    input.currentTokens,
    input.stripManagedContext,
  );
  const breakerTripped = input.state.breaker.consecutiveFailures
    >= COMPACT_CIRCUIT_BREAKER_LIMIT;
  const attempt = {
    ...compactable,
    messages: input.messages,
    currentTokens: input.currentTokens,
    hardPressure,
  };
  const compactableNeedsCompaction = needsCompaction(
    compactable.compactableMessages,
    input.compactionConfig,
    input.contextWindow,
    compactable.compactableCurrentTokens,
    input.reservedResponseTokens,
  );
  if (!compactableNeedsCompaction && !hardPressure) {
    return skippedAdmission('compactable_below_threshold', attempt, input.state.breaker);
  }

  const growthRearmed = input.state.breaker.rearmAtTokens !== undefined
    && compactable.compactableCurrentTokens >= input.state.breaker.rearmAtTokens;
  if (breakerTripped && !hardPressure
    && input.state.breaker.cooldownTurnsRemaining > 0 && !growthRearmed) {
    input.state.breaker = {
      ...input.state.breaker,
      cooldownTurnsRemaining: input.state.breaker.cooldownTurnsRemaining - 1,
    };
    return skippedAdmission('circuit_breaker_cooldown', attempt, input.state.breaker);
  }

  if (shouldSkipLlmCompaction(
    input.state.antiThrash,
    compactable.compactableCurrentTokens,
  ) && !hardPressure) {
    const reason = input.state.antiThrash.cooldownTurnsRemaining > 0
      ? 'low_savings_cooldown'
      : 'covered_context_unchanged';
    input.state.antiThrash = consumeCompactionCooldown(input.state.antiThrash);
    return skippedAdmission(reason, attempt, {
      ...input.state.breaker,
      cooldownTurnsRemaining: input.state.antiThrash.cooldownTurnsRemaining,
      rearmAtTokens: input.state.antiThrash.rearmAtTokens,
    });
  }
  return { kind: 'admitted', attempt };
}

function skippedAdmission(
  reason: CompactionSkipReason,
  attempt: ManagedCompactionAttempt,
  state: SummaryCircuitBreaker,
): ManagedCompactionAdmission {
  return {
    kind: 'skipped',
    attempt,
    reason,
    cooldownTurnsRemaining: state.cooldownTurnsRemaining,
    ...(state.rearmAtTokens !== undefined ? { rearmAtTokens: state.rearmAtTokens } : {}),
  };
}

async function buildManagedCompactionCandidate(input: {
  readonly result: CompactionResult;
  readonly canonicalManagedContext?: KodaXMessage;
  readonly immutableSystem?: KodaXMessage;
  readonly fixedOverheadTokens: number;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly preCompactionMessages: readonly KodaXMessage[];
}): Promise<ManagedCompactionCandidate> {
  const attached = await attachManagedCompactionContext(
    input.result,
    input.fixedOverheadTokens,
    input.contextWindow,
    input.reservedResponseTokens,
  );
  const attachedMessages = input.canonicalManagedContext
    ? installCanonicalManagedRunContext(attached.messages, input.canonicalManagedContext)
    : attached.messages;
  const finalMessages = prependImmutableSystem(input.immutableSystem, attachedMessages);
  const finalTokens = input.fixedOverheadTokens + estimateTokens(attachedMessages);
  // FEATURE_296 T3: judge the compacted transcript against the floor-bounded
  // shrunk reserve first — a reclaimable escalation reserve is relief, not
  // debt. Only an input that cannot fit even at the floor records debt.
  const stillOverCapacity = exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: finalTokens,
    reservedResponseTokens: reclaimReservedResponseTokens({
      contextWindow: input.contextWindow,
      currentTokens: finalTokens,
      reservedResponseTokens: input.reservedResponseTokens,
    }),
  });
  return {
    finalMessages,
    finalTokens,
    finalCompactableTokens: input.fixedOverheadTokens + estimateTokens(attached.messages),
    update: buildCompactionUpdate(
      input.result,
      finalTokens,
      input.preCompactionMessages,
      attached.postCompactAttachments,
    ),
    ...(stillOverCapacity ? { stillOverCapacity: true } : {}),
  };
}

async function persistCompaction(
  callback: NonNullable<KodaXOptions['events']>['onCompactedMessages'],
  messages: KodaXMessage[],
  update: CompactionUpdate,
): Promise<PersistenceResult> {
  try {
    await callback?.(messages, update);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function emitManagedCompactionSkipped(input: {
  readonly events: KodaXOptions['events'];
  readonly identity: CompactionDiagnosticIdentity;
  readonly attempt: ManagedCompactionAttempt;
  readonly reason: CompactionSkipReason;
  readonly contextWindow: number;
  readonly triggerPercent: number;
  readonly effectiveTriggerTokens: number;
  readonly cooldownTurnsRemaining: number;
  readonly rearmAtTokens?: number;
  readonly state: ManagedCompactionState;
}): void {
  notifyCompactionObserver(() => input.events?.onContextCompactionSkipped?.({
    ...input.identity,
    reason: input.reason,
    currentTokens: input.attempt.currentTokens,
    compactableTokens: input.attempt.compactableCurrentTokens,
    contextWindow: input.contextWindow,
    triggerPercent: input.triggerPercent,
    effectiveTriggerTokens: input.effectiveTriggerTokens,
    /** Semantic source depends on `reason`: breaker cooldown for
     * `circuit_breaker_cooldown`; anti-thrash cooldown for
     * `low_savings_cooldown` / `covered_context_unchanged`. */
    cooldownTurnsRemaining: input.cooldownTurnsRemaining,
    lowSavingsStreak: input.state.antiThrash.lowSavingsStreak,
    consecutiveFailures: input.state.breaker.consecutiveFailures,
    circuitBreakerLimit: COMPACT_CIRCUIT_BREAKER_LIMIT,
    circuitBreakerState: input.state.breaker.consecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT
      ? (input.reason === 'circuit_breaker_cooldown'
          || input.state.breaker.cooldownTurnsRemaining > 0
        ? 'open' as const
        : 'half_open' as const)
      : 'closed' as const,
    ...(input.rearmAtTokens !== undefined
      ? { rearmAtTokens: input.rearmAtTokens }
      : {}),
  }), 'Compaction skip observer failed.');
}

interface ManagedCompactionExecutionInput {
  readonly attempt: ManagedCompactionAttempt;
  readonly state: ManagedCompactionState;
  readonly options: KodaXOptions;
  readonly hookOptions: BuildManagedTaskCompactionHookOptions;
  readonly provider: Awaited<
    ReturnType<typeof resolveManagedTaskContextCapacity>
  >['provider'];
  readonly activeModel?: string;
  readonly compactionConfig: CompactionConfig;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly effectiveTriggerTokens: number;
  readonly identity: CompactionDiagnosticIdentity;
  readonly promptCacheKey?: string;
  readonly snapshotRef?: ContextTokenSnapshotRef;
}

type ManagedTerminalOutcome =
  | { readonly kind: 'stopped'; readonly endResult: KodaXCompactionEndResult }
  | {
      readonly kind: 'capacity';
      readonly endResult: KodaXCompactionEndResult;
      readonly error: ContextCapacityError;
    };

type ManagedSummaryOutcome =
  | ManagedTerminalOutcome
  | {
      readonly kind: 'ready';
      readonly result: CompactionResult;
      readonly canonicalManagedContext?: KodaXMessage;
    };

type ManagedCommitOutcome =
  | ManagedTerminalOutcome
  | {
      readonly kind: 'committed';
      readonly endResult: KodaXCompactionEndResult;
      readonly messages: readonly AgentMessage[];
    };

async function executeManagedCompactionAttempt(
  input: ManagedCompactionExecutionInput,
): Promise<readonly AgentMessage[] | undefined> {
  const { attempt, state } = input;
  const startedAt = Date.now();
  let endResult: KodaXCompactionEndResult | undefined;
  notifyCompactionObserver(
    () => input.options.events?.onCompactStart?.(),
    'Compaction start observer failed.',
  );
  try {
    const summary = await resolveManagedSummaryOutcome(input);
    if (summary.kind !== 'ready') {
      endResult = summary.endResult;
      if (summary.kind === 'capacity') throw summary.error;
      return undefined;
    }
    const committed = await commitManagedCompactionResult(
      input,
      summary,
      startedAt,
    );
    endResult = committed.endResult;
    if (committed.kind === 'capacity') throw committed.error;
    return committed.kind === 'committed' ? committed.messages : undefined;
  } catch (error) {
    if (error instanceof ContextCapacityError) {
      endResult ??= capacityEndResult(attempt, state);
      throw error;
    }
    endResult = {
      ...compactionEndState(
        attempt.currentTokens,
        attempt.compactableCurrentTokens,
        state.breaker,
      ),
      outcome: 'failed',
      reason: 'post_processing_failed',
      failurePhase: 'post_processing',
    };
    emitCompactionFailure('Managed history compaction post-processing failed.', error);
    if (attempt.hardPressure) throw capacityError(input);
    return undefined;
  } finally {
    notifyCompactionObserver(
      () => input.options.events?.onCompactEnd?.(undefined, endResult),
      'Compaction end observer failed.',
    );
  }
}

async function resolveManagedSummaryOutcome(
  input: ManagedCompactionExecutionInput,
): Promise<ManagedSummaryOutcome> {
  const { attempt, state } = input;
  const canonicalManagedContext = input.hookOptions.canonicalManagedContext?.();
  const systemPrompt = typeof attempt.immutableSystem?.content === 'string'
    ? attempt.immutableSystem.content
    : undefined;
  let result: CompactionResult;
  try {
    result = await requestManagedCompactionSummary({ ...input, systemPrompt });
  } catch (error) {
    if (error instanceof ContextCapacityError) {
      return { kind: 'capacity', endResult: capacityEndResult(attempt, state), error };
    }
    state.breaker = recordSummaryCircuitFailure(
      state.breaker,
      attempt.compactableCurrentTokens,
    );
    const endResult: KodaXCompactionEndResult = {
      ...compactionEndState(
        attempt.currentTokens,
        attempt.compactableCurrentTokens,
        state.breaker,
      ),
      outcome: 'failed',
      reason: 'summary_generation_failed',
      failurePhase: 'summary_generation',
    };
    emitCompactionFailure('Managed history compaction summary failed.', error);
    // FEATURE_296 (ADR-067): a transient summarizer failure fails open even
    // under hard pressure — canonical history is untouched and the run
    // continues; the circuit breaker bounds repeated outages. A genuine
    // ContextCapacityError (the summary request itself cannot fit) still
    // terminates above.
    return { kind: 'stopped', endResult };
  }
  if (!result.compacted) return noCompactablePrefixOutcome(input);
  return {
    kind: 'ready',
    result,
    ...(canonicalManagedContext !== undefined ? { canonicalManagedContext } : {}),
  };
}

function noCompactablePrefixOutcome(
  input: ManagedCompactionExecutionInput,
): ManagedTerminalOutcome {
  const { attempt, state } = input;
  if (attempt.hardPressure) {
    return {
      kind: 'capacity',
      endResult: capacityEndResult(attempt, state),
      error: capacityError(input),
    };
  }
  emitManagedCompactionSkipped({
    events: input.options.events,
    identity: input.identity,
    attempt,
    reason: 'no_compactable_prefix',
    contextWindow: input.contextWindow,
    triggerPercent: input.compactionConfig.triggerPercent,
    effectiveTriggerTokens: input.effectiveTriggerTokens,
    cooldownTurnsRemaining: state.breaker.cooldownTurnsRemaining,
    state,
  });
  return {
    kind: 'stopped',
    endResult: {
      ...compactionEndState(
        attempt.currentTokens,
        attempt.compactableCurrentTokens,
        state.breaker,
      ),
      outcome: 'skipped',
      reason: 'no_compactable_prefix',
    },
  };
}

async function commitManagedCompactionResult(
  input: ManagedCompactionExecutionInput,
  summary: Extract<ManagedSummaryOutcome, { readonly kind: 'ready' }>,
  startedAt: number,
): Promise<ManagedCommitOutcome> {
  const { attempt, state } = input;
  const candidate = await buildManagedCompactionCandidate({
    result: summary.result,
    canonicalManagedContext: summary.canonicalManagedContext,
    immutableSystem: attempt.immutableSystem,
    fixedOverheadTokens: attempt.fixedOverheadTokens,
    contextWindow: input.contextWindow,
    reservedResponseTokens: input.reservedResponseTokens,
    preCompactionMessages: attempt.messages,
  });
  const persisted = await persistCompaction(
    input.options.events?.onCompactedMessages,
    candidate.finalMessages,
    candidate.update,
  );
  if (!persisted.ok) return persistenceFailureOutcome(input, persisted.error);

  state.breaker = createSummaryCircuitBreaker();
  state.antiThrash = recordCompactionSavings(state.antiThrash, {
    tokensBefore: attempt.compactableCurrentTokens,
    tokensAfter: candidate.finalCompactableTokens,
  }).state;
  notifyPostCompact(input.hookOptions.onPostCompact);
  updateSnapshot(input.snapshotRef, candidate.finalMessages, candidate.finalTokens);
  if (candidate.stillOverCapacity) {
    emitKodaXDiagnostic({
      source: 'coding:managed-compaction',
      level: 'error',
      message:
        `Compacted history still requires ${candidate.finalTokens} tokens against the `
        + `${input.contextWindow}-token window; the recovery ladder must relieve `
        + `capacity before the next request (FEATURE_296).`,
    });
  }
  const endResult: KodaXCompactionEndResult = {
    ...compactionEndState(
      attempt.currentTokens,
      attempt.compactableCurrentTokens,
      state.breaker,
    ),
    outcome: 'compacted',
    ...(candidate.stillOverCapacity ? { stillOverCapacity: true } : {}),
  };
  emitCommittedCompaction(input, candidate, summary.result, startedAt);
  return { kind: 'committed', endResult, messages: candidate.finalMessages };
}

function persistenceFailureOutcome(
  input: ManagedCompactionExecutionInput,
  error: unknown,
): ManagedTerminalOutcome {
  const { attempt, state } = input;
  state.breaker = recordSummaryCircuitFailure(
    state.breaker,
    attempt.compactableCurrentTokens,
  );
  const endResult: KodaXCompactionEndResult = {
    ...compactionEndState(
      attempt.currentTokens,
      attempt.compactableCurrentTokens,
      state.breaker,
    ),
    outcome: 'failed',
    reason: 'persistence_failed',
    failurePhase: 'persistence',
  };
  emitCompactionFailure('Managed history compaction persistence failed.', error);
  return attempt.hardPressure
    ? { kind: 'capacity', endResult, error: capacityError(input) }
    : { kind: 'stopped', endResult };
}

async function requestManagedCompactionSummary(
  input: ManagedCompactionExecutionInput & { readonly systemPrompt?: string },
): Promise<CompactionResult> {
  const observer = input.options.context?.contextDiagnostics === true
    ? createCompactionPromptCacheObserver({
        events: input.options.events,
        enabled: true,
        provider: input.provider,
        providerName: input.provider.name,
        ...input.identity,
        model: input.activeModel ?? input.provider.getModel(),
        disablePromptCache: input.options.disablePromptCache,
      })
    : undefined;
  const cacheContext = input.systemPrompt !== undefined
    && input.hookOptions.activeToolDefinitions !== undefined
    ? {
        tools: input.hookOptions.activeToolDefinitions,
        reasoning: input.hookOptions.reasoning,
      }
    : undefined;
  return intelligentCompact(
    input.attempt.compactableMessages,
    input.compactionConfig,
    input.provider,
    input.contextWindow,
    undefined,
    input.systemPrompt,
    input.attempt.compactableCurrentTokens,
    CODING_SUMMARY_PROMPT,
    CODING_UPDATE_SUMMARY_PROMPT,
    input.activeModel,
    input.attempt.hardPressure,
    input.reservedResponseTokens,
    cacheContext,
    observer,
    input.promptCacheKey !== undefined ? { promptCacheKey: input.promptCacheKey } : undefined,
  );
}

function capacityEndResult(
  attempt: ManagedCompactionAttempt,
  state: ManagedCompactionState,
): KodaXCompactionEndResult {
  return {
    ...compactionEndState(
      attempt.currentTokens,
      attempt.compactableCurrentTokens,
      state.breaker,
    ),
    outcome: 'failed',
    reason: 'context_capacity_exceeded',
  };
}

function capacityError(input: ManagedCompactionExecutionInput): ContextCapacityError {
  return new ContextCapacityError({
    contextWindow: input.contextWindow,
    currentTokens: input.attempt.currentTokens,
    reservedResponseTokens: input.reservedResponseTokens,
  }, 'Managed history compaction');
}

function emitCompactionFailure(message: string, error: unknown): void {
  emitKodaXDiagnostic({
    source: 'coding:managed-compaction',
    level: 'error',
    message,
    detail: error,
  });
}

function emitCommittedCompaction(
  input: ManagedCompactionExecutionInput,
  candidate: ManagedCompactionCandidate,
  result: CompactionResult,
  startedAt: number,
): void {
  const events = input.options.events;
  notifyCompactionObserver(() => events?.onCompactStats?.({
    tokensBefore: input.attempt.currentTokens,
    tokensAfter: candidate.finalTokens,
  }), 'Compaction stats observer failed.');
  notifyCompactionObserver(
    () => events?.onCompact?.(candidate.finalTokens),
    'Compaction completion observer failed.',
  );
  notifyCompactionObserver(() => events?.onContextCompactionFinished?.({
    source: input.attempt.hardPressure ? 'physical_capacity' : 'automatic_threshold',
    tokensBefore: input.attempt.currentTokens,
    tokensAfter: candidate.finalTokens,
    committed: true,
    elapsedMs: Date.now() - startedAt,
    ...(result.report ?? {}),
  }), 'Canonical compaction observer failed.');
}

/** Build the hook invoked before each managed Runner provider request. */
export async function buildManagedTaskCompactionHook(
  options: KodaXOptions,
  hookOptions: BuildManagedTaskCompactionHookOptions = {},
): Promise<RunnerCompactionHook | undefined> {
  const resolved = hookOptions.resolvedContextCapacity
    ?? await resolveManagedTaskContextCapacity(options);
  const { provider, activeModel, compactionConfig, contextWindow } = resolved;

  const events = options.events;
  const snapshotRef = hookOptions.contextTokenSnapshotRef;
  const reservedResponseTokens = provider.getEffectiveMaxOutputTokens(activeModel);
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
    contextKind: diagnosticAgentId === undefined ? 'root' as const : 'child' as const,
    ...(diagnosticSessionId !== undefined && diagnosticAgentId !== undefined
      ? {
          parentContextId: diagnosticParentAgentId === undefined
            || diagnosticParentAgentId === '/root'
            ? diagnosticSessionId
            : `${diagnosticSessionId}/agent/${encodeURIComponent(diagnosticParentAgentId)}`,
        }
      : {}),
    ...(diagnosticAgentId !== undefined ? { agentId: diagnosticAgentId } : {}),
  };
  const promptCacheKey = resolvePromptCacheDisabled(options.disablePromptCache)
    ? undefined
    : derivePromptCacheAffinityKey({
        logicalSessionId: diagnosticSessionId,
        ...(diagnosticAgentId !== undefined ? { agentId: diagnosticAgentId } : {}),
      });
  const effectiveTriggerTokens = resolveCompactionPolicy(
    compactionConfig,
    contextWindow,
    calculateMaxContextInputTokens(contextWindow, reservedResponseTokens),
  ).triggerTokens;
  const state: ManagedCompactionState = {
    breaker: createSummaryCircuitBreaker(),
    antiThrash: createCompactionAntiThrashState(),
  };

  return async (transcript) => {
    const messages = transcript as unknown as KodaXMessage[];
    const snapshot = initializeEnvelopeEstimate(
      snapshotRef,
      messages,
      hookOptions.activeToolDefinitions ?? [],
    );
    const currentTokens = snapshot
      ? resolveContextTokenCount(messages, snapshot)
      : estimateTokens(messages);
    const admission = admitManagedCompactionAttempt({
      messages,
      currentTokens,
      compactionConfig,
      contextWindow,
      reservedResponseTokens,
      stripManagedContext: hookOptions.canonicalManagedContext !== undefined,
      state,
    });
    if (admission.kind === 'none') return undefined;
    if (admission.kind === 'skipped') {
      emitManagedCompactionSkipped({
        events,
        identity: diagnosticContextIdentity,
        attempt: admission.attempt,
        reason: admission.reason,
        contextWindow,
        triggerPercent: compactionConfig.triggerPercent,
        effectiveTriggerTokens,
        cooldownTurnsRemaining: admission.cooldownTurnsRemaining,
        ...(admission.rearmAtTokens !== undefined
          ? { rearmAtTokens: admission.rearmAtTokens }
          : {}),
        state,
      });
      return undefined;
    }

    return executeManagedCompactionAttempt({
      attempt: admission.attempt,
      state,
      options,
      hookOptions,
      provider,
      ...(activeModel !== undefined ? { activeModel } : {}),
      compactionConfig,
      contextWindow,
      reservedResponseTokens,
      effectiveTriggerTokens,
      identity: diagnosticContextIdentity,
      ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
      ...(snapshotRef !== undefined ? { snapshotRef } : {}),
    });
  };
}
