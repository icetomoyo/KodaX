/**
 * sideQuery — independent one-shot LLM invocation.
 *
 * Used by features that need a clean LLM call outside the main agent loop.
 * The auto mode classifier (FEATURE_092) is the first consumer; future
 * users include compaction, title generation, and SA mutation reflection.
 *
 * Constraints (deliberate):
 *   - tools=[] hardcoded — sideQuery is single-turn, no tool loop
 *   - text-only output — tool_use blocks from the model produce stopReason='error'
 *   - independent timeout (default 30s; callers may supply a bounded deadline)
 *   - independent cost bucket via querySource (mapped to TokenUsageRecord.role)
 *
 * Failure handling: never throws. Timeout, abort, provider error, and
 * unexpected tool_use all produce a result with stopReason='timeout' /
 * 'aborted' / 'error' so callers implement their own degradation.
 */

import { performance } from 'node:perf_hooks';

import type {
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXReasoningProfile,
  KodaXTokenUsage,
} from './types.js';
import { KodaXBaseProvider } from './providers/base.js';
import { type CostTracker, recordRetry, recordUsage } from './cost-tracker.js';
import { classifyStopReason } from './stop-reason.js';
import {
  withProviderRequestCredential,
  type ProviderCredentialPurpose,
} from './provider-credential-context.js';

export type SideQueryStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'timeout'
  | 'aborted'
  | 'error';

export interface SideQueryRequest {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly KodaXMessage[];
  readonly reasoning?: KodaXReasoningRequest;
  /** Optional per-request cap for small structured sidecar responses. */
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly querySource: string;
  /** Auditable credential purpose for this one-shot request. Defaults to utility. */
  readonly credentialPurpose?: ProviderCredentialPurpose;
  readonly costTracker?: CostTracker;
}

export interface SideQueryResult {
  readonly text: string;
  readonly usage: KodaXTokenUsage;
  readonly costTracker?: CostTracker;
  readonly stopReason: SideQueryStopReason;
  /**
   * Bounded request metadata only; prompts and response text are never copied.
   * The built-in `sideQuery()` always supplies it. Optionality preserves source
   * compatibility for existing SDK mocks and structural result adapters.
   */
  readonly diagnostics?: SideQueryDiagnostics;
  readonly error?: Error;
}

export type SideQueryTerminalPhase =
  | 'completed'
  | 'pre_output'
  | 'awaiting_text'
  | 'thinking'
  | 'streaming'
  | 'contract_error';

export interface SideQueryDiagnostics {
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly systemBytes: number;
  readonly messageBytes: number;
  readonly promptBytes: number;
  readonly retryCount: number;
  readonly retryWaitMs: number;
  /** Provider completion mapped to the stable side-query stop taxonomy. */
  readonly stopReason?: SideQueryStopReason;
  /** UTF-8 size of returned text only; response content is never persisted. */
  readonly responseBytes?: number;
  /** Number of provider text blocks concatenated into the returned text. */
  readonly textBlockCount?: number;
  /** Time until the first lifecycle/data event exposed by the provider adapter. */
  readonly firstUpstreamEventMs?: number;
  /** Time until the first non-empty thinking delta. */
  readonly firstThinkingDeltaMs?: number;
  /** Time until the first non-empty text delta. */
  readonly firstTextDeltaMs?: number;
  /** Time until the first non-empty text delta, when the adapter exposes it. */
  readonly firstOutputMs?: number;
  /** Time from the first observed text delta until termination. */
  readonly streamMs?: number;
  /** Honest coarse phase; provider adapters cannot split DNS/connect/remote queue. */
  readonly terminalPhase: SideQueryTerminalPhase;
}

const EMPTY_USAGE: KodaXTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SIDE_QUERY_LOW_THINKING_TOKENS = 1024;

function resolveDefaultSideQueryReasoning(
  profile: KodaXReasoningProfile | undefined,
): KodaXReasoningRequest | undefined {
  if (!profile) return { effort: 'none' };

  const rejected = new Set(profile.localRejectEfforts ?? []);
  const visibleEfforts = profile.supportedEfforts
    ?.filter((preset) => preset.isUserVisible !== false)
    .map((preset) => preset.value)
    .filter((effort) => !rejected.has(effort));

  if (
    !rejected.has('none') &&
    (profile.supportsDisabledThinking === true || visibleEfforts?.includes('none'))
  ) {
    return { effort: 'none' };
  }

  const lowestEnabledEffort = visibleEfforts?.find((effort) => effort !== 'none');
  return lowestEnabledEffort === undefined
    ? undefined
    : { effort: lowestEnabledEffort };
}

function resolveSideQueryMaxOutputTokens(
  requestedTokens: number | undefined,
  profile: KodaXReasoningProfile | undefined,
  reasoning: KodaXReasoningRequest | undefined,
  usesDefaultReasoning: boolean,
): number | undefined {
  if (!usesDefaultReasoning || !isPositiveInteger(requestedTokens) || !profile) {
    return requestedTokens;
  }

  const effort = reasoning?.effort;
  const thinkingDisabled = effort === 'none'
    || (effort !== undefined && profile.disabledEfforts?.includes(effort) === true);
  const cannotDisableThinking = profile.supportsDisabledThinking === false
    || profile.localRejectEfforts?.includes('none') === true;
  if (thinkingDisabled || !cannotDisableThinking) return requestedTokens;

  // Always-thinking APIs can consume the whole output window before emitting
  // the classifier contract. Keep the caller's small structured-response cap
  // as the final-text reserve, then add one bounded low-effort thinking window.
  // For provider-budget APIs this also prevents max_tokens=256 paired with the
  // adapters' minimum budget_tokens=1024.
  return requestedTokens + SIDE_QUERY_LOW_THINKING_TOKENS;
}

export async function sideQuery(req: SideQueryRequest): Promise<SideQueryResult> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let costTracker = req.costTracker;
  const startedAt = performance.now();
  const systemBytes = Buffer.byteLength(req.system, 'utf8');
  const messageBytes = Buffer.byteLength(JSON.stringify(req.messages), 'utf8');
  let firstUpstreamEventMs: number | undefined;
  let firstThinkingDeltaMs: number | undefined;
  let firstOutputMs: number | undefined;
  let retryCount = 0;
  let retryWaitMs = 0;

  const diagnostics = (
    terminalPhase: SideQueryTerminalPhase,
    completion?: {
      readonly stopReason: SideQueryStopReason;
      readonly responseBytes?: number;
      readonly textBlockCount?: number;
    },
  ): SideQueryDiagnostics => {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      provider: req.provider.name,
      model: req.model,
      timeoutMs,
      elapsedMs,
      systemBytes,
      messageBytes,
      promptBytes: systemBytes + messageBytes,
      retryCount,
      retryWaitMs,
      ...(completion !== undefined ? completion : {}),
      ...(firstUpstreamEventMs !== undefined ? { firstUpstreamEventMs } : {}),
      ...(firstThinkingDeltaMs !== undefined ? { firstThinkingDeltaMs } : {}),
      ...(firstOutputMs !== undefined
        ? {
            firstTextDeltaMs: firstOutputMs,
            firstOutputMs,
            streamMs: Math.max(0, elapsedMs - firstOutputMs),
          }
        : {}),
      terminalPhase,
    };
  };

  // Track which source aborted FIRST so the resulting stopReason label is
  // deterministic when timeout and parent-abort fire near-simultaneously.
  // Without this, both `controller.signal.aborted` and `req.abortSignal.aborted`
  // can be true by the time the catch block runs, and the label loses fidelity.
  let abortCause: 'timeout' | 'parent' | undefined;
  const recordAbort = (cause: 'timeout' | 'parent'): void => {
    if (!abortCause) abortCause = cause;
    controller.abort();
  };

  const timeoutHandle = setTimeout(() => recordAbort('timeout'), timeoutMs);

  const onParentAbort = (): void => recordAbort('parent');
  if (req.abortSignal) {
    if (req.abortSignal.aborted) {
      recordAbort('parent');
    } else {
      req.abortSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const elapsed = (): number => Math.max(
    0,
    Math.round(performance.now() - startedAt),
  );
  const recordUpstreamEvent = (): void => {
    if (firstUpstreamEventMs === undefined) firstUpstreamEventMs = elapsed();
  };
  let onControllerAbort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    onControllerAbort = () => {
      reject(new DOMException(
        abortCause === 'timeout' ? 'sideQuery timed out' : 'sideQuery aborted',
        'AbortError',
      ));
    };
    if (controller.signal.aborted) {
      onControllerAbort();
    } else {
      controller.signal.addEventListener('abort', onControllerAbort, { once: true });
    }
  });

  try {
    const reasoningProfile = req.provider.getReasoningProfile(req.model);
    const reasoning = req.reasoning ?? resolveDefaultSideQueryReasoning(reasoningProfile);
    const maxOutputTokens = resolveSideQueryMaxOutputTokens(
      req.maxOutputTokens,
      reasoningProfile,
      reasoning,
      req.reasoning === undefined,
    );
    const providerResult = withProviderRequestCredential(
      req.provider.name,
      req.credentialPurpose ?? 'utility',
      controller.signal,
      (credentialSignal) => req.provider.stream(
        [...req.messages],
        [],
        req.system,
        reasoning,
        {
          modelOverride: req.model,
          ...(isPositiveInteger(maxOutputTokens)
            ? { maxOutputTokensOverride: maxOutputTokens }
            : {}),
          onTextDelta: (text) => {
            recordUpstreamEvent();
            if (text.length > 0 && firstOutputMs === undefined) {
              firstOutputMs = elapsed();
            }
          },
          onThinkingDelta: (text) => {
            recordUpstreamEvent();
            if (text.length > 0 && firstThinkingDeltaMs === undefined) {
              firstThinkingDeltaMs = elapsed();
            }
          },
          onHeartbeat: () => recordUpstreamEvent(),
          onRetryAfter: (event) => {
            recordUpstreamEvent();
            retryCount += 1;
            retryWaitMs += Math.max(0, event.waitMs);
            if (!costTracker) return;
            costTracker = recordRetry(costTracker, {
              provider: event.provider,
              waitMs: event.waitMs,
              reason: event.reason,
              source: event.source,
            });
          },
        },
        credentialSignal,
      ),
    );
    const result = await Promise.race([providerResult, interruption]);

    const usage = result.usage ?? EMPTY_USAGE;
    const textBlocks = result.textBlocks ?? [];
    const toolBlocks = result.toolBlocks ?? [];
    const text = textBlocks.map((b) => b.text).join('');
    const responseShape = {
      responseBytes: Buffer.byteLength(text, 'utf8'),
      textBlockCount: textBlocks.length,
    };

    if (toolBlocks.length > 0) {
      return {
        text,
        usage,
        costTracker,
        stopReason: 'error',
        diagnostics: diagnostics('contract_error', {
          stopReason: 'error',
          ...responseShape,
        }),
        error: new Error(
          `sideQuery: provider returned ${toolBlocks.length} tool_use block(s); sideQuery expects text-only output`,
        ),
      };
    }

    if (costTracker) {
      costTracker = recordUsage(costTracker, {
        provider: req.provider.name,
        model: req.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cachedReadTokens,
        cacheWriteTokens: usage.cachedWriteTokens,
        role: req.querySource,
      });
    }

    const stopReason = mapStopReason(result.stopReason);
    return {
      text,
      usage,
      costTracker,
      stopReason,
      diagnostics: diagnostics('completed', { stopReason, ...responseShape }),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    let stopReason: SideQueryStopReason = 'error';
    if (controller.signal.aborted) {
      stopReason = abortCause === 'timeout' ? 'timeout' : 'aborted';
    }

    return {
      text: '',
      usage: EMPTY_USAGE,
      costTracker,
      stopReason,
      diagnostics: diagnostics(
        firstOutputMs !== undefined
          ? 'streaming'
          : firstThinkingDeltaMs !== undefined
            ? 'thinking'
            : firstUpstreamEventMs !== undefined
              ? 'awaiting_text'
            : 'pre_output',
        { stopReason },
      ),
      error,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (req.abortSignal) {
      req.abortSignal.removeEventListener('abort', onParentAbort);
    }
    if (onControllerAbort) {
      controller.signal.removeEventListener('abort', onControllerAbort);
    }
  }
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

// Provider stop reasons we recognize:
//   'max_tokens' → output truncation (caller may want to retry with larger budget)
//   'end_turn' / 'stop_sequence' / undefined → normal completion
//   'tool_use' → unreachable here (toolBlocks check above already errored out)
// Any unknown future value is conservatively treated as a normal completion;
// the caller's parsing of `text` is the authoritative success signal.
function mapStopReason(raw: string | undefined): SideQueryStopReason {
  if (classifyStopReason(raw) === 'truncated') return 'max_tokens';
  return 'end_turn';
}
