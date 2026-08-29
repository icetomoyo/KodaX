/**
 * FEATURE_215 (v0.7.49) — Generic LLM-judged stop-hook primitive.
 *
 * Domain-neutral kernel for the "second-pass LLM consult" pattern shared
 * by `@kodax-ai/coding`'s Sidecar Verifier (FEATURE_184) and Stall
 * Sidecar (FEATURE_178). Both consumers ran the identical skeleton:
 *
 *   provider.stream (forced tool call) → fuzzy-match the report tool
 *   → parse the verdict → race a timeout → fail-open on any failure
 *
 * This module lifts that skeleton to the agent layer as a reusable
 * primitive so external SDK consumers building on a bare `Runner` can
 * inject their own domain prompt + verdict parser and get the same
 * text-only-termination consult behavior — without dragging the coding
 * preset in or copy-pasting the 35-line stream/parse/timeout boilerplate.
 *
 * **ADR-030 boundary**: concrete LLM judging (domain prompt, file-edit
 * evidence, verdict landing) stays in `@kodax-ai/coding`. Only the
 * domain-neutral *invocation* kernel lives here. This is an application
 * of ADR-021 ("non-coding agents also need it → agent layer"), not a
 * contradiction of ADR-030's "do not generalize concrete judging".
 *
 * **Never throws.** Every internal failure mode (provider error, timeout,
 * no tool call, parse failure) resolves to the caller-supplied
 * `defaultVerdict(reason)` so the happy path is never blocked by a buggy
 * judge.
 */

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { withProviderRequestCredential } from '@kodax-ai/llm';

import type { StopHookContext, StopHookFn, StopHookResult } from '../primitives/runner.js';

/**
 * Levenshtein edit distance between two strings. Short, no regex. Used
 * by `findFuzzyToolMatch` to absorb model tool-name typos (e.g.
 * `report_stall_jundgment` → `report_stall_judgment`) that surface in
 * production sidecar calls.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Find the tool_use block whose name matches `expectedToolName` exactly
 * or within edit distance 2 (picking the closest). Returns undefined
 * when no candidate is close enough. `exact` distinguishes an exact hit
 * from a fuzzy one so callers can tag their verdict trace accordingly.
 */
export function findFuzzyToolMatch(
  toolBlocks: readonly KodaXToolUseBlock[],
  expectedToolName: string,
): { block: KodaXToolUseBlock; exact: boolean } | undefined {
  const exact = toolBlocks.find((b) => b.name === expectedToolName);
  if (exact) return { block: exact, exact: true };

  let best: { block: KodaXToolUseBlock; distance: number } | undefined;
  for (const b of toolBlocks) {
    const d = editDistance(b.name, expectedToolName);
    if (d <= 2 && (best === undefined || d < best.distance)) {
      best = { block: b, distance: d };
    }
  }
  return best ? { block: best.block, exact: false } : undefined;
}

/**
 * Why the kernel fell back to `defaultVerdict`. The consumer maps each
 * reason to its own domain verdict + diagnostic trace tag.
 */
export type LlmJudgeFailureReason =
  | 'provider_error'
  | 'timeout'
  | 'no_tool_call'
  | 'parse_failure';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_JUDGE_MAX_OUTPUT_TOKENS = 1024;

export interface InvokeLlmJudgeOptions<TVerdict> {
  /** Provider used for the consult call. Often a stronger model than the
   *  main agent's. Injection target = test fakes + production resolution. */
  readonly provider: KodaXBaseProvider;
  /** Specific model id on the provider. When omitted, the provider's
   *  registered default model is used. */
  readonly model?: string;
  /** System prompt for the consult. Domain-specific — caller supplies. */
  readonly systemPrompt: string;
  /** Forced report tool definition. Domain-specific — caller supplies. */
  readonly reportTool: KodaXToolDefinition;
  /** Pre-rendered user-message body for the consult. */
  readonly userMessage: string;
  /** Canonical report tool name used for exact + fuzzy matching. */
  readonly reportToolName: string;
  /** Parse a matched tool_use block into a verdict. `exact` is false on
   *  a fuzzy (edit-distance) match. Return undefined — or throw — to
   *  signal a parse failure → `defaultVerdict('parse_failure')`. A
   *  throwing parser never breaks the "never throws" contract. */
  readonly parseToolCall: (block: KodaXToolUseBlock, exact: boolean) => TVerdict | undefined;
  /** Safe-default verdict factory, keyed by the failure reason so the
   *  caller can preserve distinct diagnostic traces. */
  readonly defaultVerdict: (reason: LlmJudgeFailureReason) => TVerdict;
  /** Timeout in ms. Default 15000. */
  readonly timeoutMs?: number;
  /** Caller cancellation signal; combined with the judge timeout signal. */
  readonly abortSignal?: AbortSignal;
  /** Short structured-call output cap. Default 1024. */
  readonly maxOutputTokens?: number;
  /** Optional logical cache domain owned by the caller. */
  readonly promptCacheKey?: string;
}

/**
 * Run a one-shot LLM consult: a single forced tool call, fuzzy-matched,
 * parsed, raced against a timeout, failing open to `defaultVerdict` on
 * any error. Domain-neutral via the `TVerdict` generic. Never throws.
 */
export async function invokeLlmJudge<TVerdict>(
  options: InvokeLlmJudgeOptions<TVerdict>,
): Promise<TVerdict> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_JUDGE_MAX_OUTPUT_TOKENS;
  const messages: KodaXMessage[] = [{ role: 'user', content: options.userMessage }];
  const streamController = new AbortController();
  const streamSignal = streamController.signal;
  let onCallerAbort: () => void = () => {};
  const callerAbortPromise = new Promise<TVerdict>((resolve) => {
    onCallerAbort = () => {
      streamController.abort();
      resolve(options.defaultVerdict('provider_error'));
    };
  });
  // Register the listener BEFORE reading `aborted` so there is no gap (even a
  // theoretical one under a future async refactor) where an abort between the
  // check and the registration is missed. `addEventListener` on an already-
  // aborted signal never fires, so the explicit post-check covers that case.
  options.abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (options.abortSignal?.aborted) {
    onCallerAbort();
  }

  const streamPromise = (async (): Promise<TVerdict> => {
    let result;
    try {
      result = await withProviderRequestCredential(
        options.provider.name,
        'sidecar',
        streamSignal,
        (credentialSignal) => options.provider.stream(
          messages,
          [options.reportTool],
          options.systemPrompt,
          false,
          {
            ...(options.model ? { modelOverride: options.model } : {}),
            forcedToolName: options.reportToolName,
            maxOutputTokensOverride: maxOutputTokens,
            ...(options.promptCacheKey === undefined
              ? {}
              : { promptCacheKey: options.promptCacheKey }),
            signal: credentialSignal,
          },
          credentialSignal,
        ),
      );
    } catch {
      return options.defaultVerdict('provider_error');
    }

    const match = findFuzzyToolMatch(result.toolBlocks ?? [], options.reportToolName);
    if (!match) {
      return options.defaultVerdict('no_tool_call');
    }
    // The parser is caller-supplied — a throwing parser must not break
    // the "never throws" contract. Any throw maps to parse_failure, same
    // as a returned undefined.
    let parsed: TVerdict | undefined;
    try {
      parsed = options.parseToolCall(match.block, match.exact);
    } catch {
      return options.defaultVerdict('parse_failure');
    }
    if (parsed === undefined) {
      return options.defaultVerdict('parse_failure');
    }
    return parsed;
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<TVerdict>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve(options.defaultVerdict('timeout'));
      streamController.abort();
    }, timeoutMs);
  });

  const verdict = await Promise.race([streamPromise, timeoutPromise, callerAbortPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  options.abortSignal?.removeEventListener('abort', onCallerAbort);
  return verdict;
}

export interface CreateLlmJudgedStopHookOptions<TVerdict> {
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
  readonly systemPrompt: string;
  readonly reportTool: KodaXToolDefinition;
  readonly reportToolName: string;
  /** Build the consult's user message from the StopHook context. */
  readonly buildUserMessage: (ctx: StopHookContext) => string | Promise<string>;
  readonly parseToolCall: (block: KodaXToolUseBlock, exact: boolean) => TVerdict | undefined;
  readonly defaultVerdict: (reason: LlmJudgeFailureReason) => TVerdict;
  /** Map the resolved verdict to the agent-layer 3-state StopHookResult. */
  readonly mapVerdict: (verdict: TVerdict) => StopHookResult;
  /** Observability sink — called once per hook fire with the raw verdict. */
  readonly onVerdict?: (verdict: TVerdict) => void;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

function throwIfJudgeCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('LLM judge cancelled by caller.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Factory: returns a `StopHookFn` that runs `invokeLlmJudge` when the
 * main agent terminates a turn text-only, then maps the verdict to the
 * agent-layer 3-state result. The hook builds the consult user message
 * from the StopHook context via `buildUserMessage`, so callers stay in
 * control of what context the judge sees.
 */
export function createLlmJudgedStopHook<TVerdict>(
  options: CreateLlmJudgedStopHookOptions<TVerdict>,
): StopHookFn {
  return async (ctx): Promise<StopHookResult> => {
    throwIfJudgeCallerAborted(ctx.abortSignal);
    const userMessage = await options.buildUserMessage(ctx);
    throwIfJudgeCallerAborted(ctx.abortSignal);
    const verdict = await invokeLlmJudge<TVerdict>({
      provider: options.provider,
      model: options.model,
      systemPrompt: options.systemPrompt,
      reportTool: options.reportTool,
      userMessage,
      reportToolName: options.reportToolName,
      parseToolCall: options.parseToolCall,
      defaultVerdict: options.defaultVerdict,
      timeoutMs: options.timeoutMs,
      abortSignal: ctx.abortSignal,
      maxOutputTokens: options.maxOutputTokens,
    });
    // `invokeLlmJudge` intentionally fails open for provider failures, but a
    // caller cancellation is lifecycle state, not an accept verdict. Check
    // again before any observer or mapper can turn an aborted verifier call
    // into successful task completion.
    throwIfJudgeCallerAborted(ctx.abortSignal);
    options.onVerdict?.(verdict);
    return options.mapVerdict(verdict);
  };
}
