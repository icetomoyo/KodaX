/**
 * FEATURE_121 v0.7.40 follow-up — LLM blob summarizer.
 *
 * Last-resort lossy compression for child-task content that would
 * otherwise be lost or blow up Worker context. Triggered by
 * `dispatch-child-tasks.ts` when `applyToolResultGuardrail` returns
 * `spillFailed: true` AND the original raw content exceeds
 * `LARGE_CONTENT_THRESHOLD_BYTES` — at that point inlining the full
 * payload would blow past the LLM context window with no spill path
 * to recover from. The summarizer compresses to roughly 4-8 KB while
 * preserving the structural and ground-truth tokens (file paths,
 * line numbers, error codes, findings).
 *
 * Layer independence: this module lives in `@kodax-ai/coding` (the
 * coding layer carries the LLM client wiring). The fallback callback
 * is injected into `KodaXToolExecutionContext.summarizeBlob` at
 * task-engine init time so the dispatch tool can call it via `ctx`
 * without owning provider construction.
 *
 * Failure mode: the summarizer throws on empty / aborted / provider
 * error. Caller (dispatch-child-tasks) catches and falls back to the
 * existing inline-full-content path (matches the FEATURE_121 spill-
 * failure data-loss guard contract: silent loss is the worst outcome;
 * inlining over-budget is acceptable).
 */

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXProviderStreamOptions,
  KodaXTextBlock,
} from '@kodax-ai/llm';
import { withProviderRequestCredential } from '@kodax-ai/llm';
import type { KodaXEvents } from '../types.js';
import { emitProviderRateLimit } from '../agent-runtime/event-emitter.js';

/** ~100 KB inline budget — beyond this, inlining alone risks blowing the
 * Worker's context window on common 128 K-token models (≈ 25 K tokens
 * just for the inlined blob, leaving little room for the rest of the
 * conversation). The summarizer compresses ~12× down into the 4-8 KB
 * banner band. Below the threshold the simple inline path remains
 * cheaper and zero-cost. */
export const LARGE_CONTENT_THRESHOLD_BYTES = 100 * 1024;

/** Target compressed-summary band the LLM is asked to produce. */
export const DEFAULT_SUMMARY_MAX_CHARS = 8000;
export const DEFAULT_SUMMARY_MIN_CHARS = 2000;

/** Hard wall for the summary LLM call. 30 s covers slow Chinese coding-
 * plan providers; beyond that we treat the summarizer as failed and
 * caller falls back to inline. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;

/** Exported so the Layer 2 eval (`tests/feature-121-blob-summarizer.eval.ts`)
 * pins the EXACT prompt text the production summarizer uses. If you change
 * this constant, re-run the eval to confirm cross-panel retention stays
 * above the SHIP threshold. */
export const SUMMARIZER_SYSTEM_PROMPT =
  'You are a faithful lossy summarizer. ' +
  'Reply with the summary text only — no preamble, no closing remarks, no markdown code fences.';

/** Exported with the same rationale as `SUMMARIZER_SYSTEM_PROMPT`. */
export function buildSummarizerUserMessage(content: string, maxChars: number): string {
  const minChars = Math.max(DEFAULT_SUMMARY_MIN_CHARS, Math.floor(maxChars / 4));
  return [
    'The following content failed to spill to disk and is too large to inline',
    `into the agent's context. Compress to roughly ${minChars}-${maxChars} characters,`,
    'PRESERVING VERBATIM:',
    '- All file paths, line numbers, error codes, identifiers',
    '- All explicit findings, decisions, conclusions',
    '- Section headers and list structure',
    'You MAY omit: verbose prose, long examples, code snippets longer than 20 lines.',
    'Reply with the summary ONLY. No preamble, no closing remarks.',
    '',
    'CONTENT:',
    content,
  ].join('\n');
}

export interface SummarizeBlobOptions {
  /** Target compressed length cap. Default `DEFAULT_SUMMARY_MAX_CHARS`. */
  readonly maxChars?: number;
  /** Caller's abort signal (typically Worker's run abort). Aborts the LLM call. */
  readonly abortSignal?: AbortSignal;
}

/** Callback shape stored on `KodaXToolExecutionContext.summarizeBlob`. */
export type SummarizeBlob = (
  content: string,
  options?: SummarizeBlobOptions,
) => Promise<string>;

export interface CreateBlobSummarizerOptions {
  readonly provider: KodaXBaseProvider;
  /** Model id for the underlying provider. `undefined` means use the
   *  provider's registered default. Error messages render `undefined`
   *  as `(default)` for diagnostic clarity. DO NOT pass a placeholder
   *  like `'unknown'` — see FEATURE_187 Phase B code review (same
   *  sentinel-truthiness pitfall as sidecar-verifier / stall-sidecar). */
  readonly model: string | undefined;
  readonly events?: KodaXEvents;
  /** Override the 30 s wall. Tests pass small values to keep them fast. */
  readonly timeoutMs?: number;
}

export class BlobSummarizerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BlobSummarizerError';
  }
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const onAbort = (): void => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const c of cleanups) c();
    },
  };
}

/**
 * Build a `SummarizeBlob` callback bound to a specific provider/model.
 * Task-engine constructs one per Worker run (using the Worker's own
 * provider/model) and threads it into `KodaXToolExecutionContext`.
 */
export function createBlobSummarizer(
  opts: CreateBlobSummarizerOptions,
): SummarizeBlob {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;

  return async (content, summaryOpts) => {
    if (content.length === 0) {
      throw new BlobSummarizerError('blob summarizer called with empty content');
    }
    const maxChars = summaryOpts?.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;

    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new Error('summarizer timeout')), timeoutMs);

    const { signal: combinedSignal, cleanup } = combineAbortSignals([
      summaryOpts?.abortSignal,
      timeoutCtrl.signal,
    ]);

    const messages: KodaXMessage[] = [
      { role: 'user', content: buildSummarizerUserMessage(content, maxChars) },
    ];
    const events = opts.events;
    const streamOptions: KodaXProviderStreamOptions | undefined = events
      ? {
          onRateLimit: (attempt, maxRetries, delayMs) => {
            emitProviderRateLimit(events, attempt, maxRetries, delayMs);
          },
          onRetryAfter: (event) => {
            events.onRetryAfter?.(event);
          },
        }
      : undefined;
    const effectiveStreamOptions: KodaXProviderStreamOptions | undefined =
      streamOptions || opts.model
        ? {
            ...(streamOptions ?? {}),
            ...(opts.model ? { modelOverride: opts.model } : {}),
          }
        : undefined;

    try {
      const result = await withProviderRequestCredential(
        opts.provider.name,
        'utility',
        combinedSignal,
        (credentialSignal) => opts.provider.stream(
          messages,
          [],
          SUMMARIZER_SYSTEM_PROMPT,
          undefined,
          effectiveStreamOptions,
          credentialSignal,
        ),
      );
      const text = (result.textBlocks as readonly KodaXTextBlock[])
        .map((b) => b.text)
        .join('')
        .trim();
      if (text.length === 0) {
        throw new BlobSummarizerError(
          `blob summarizer (${opts.model ?? '(default)'}) returned empty text`,
        );
      }
      return text;
    } catch (err) {
      if (err instanceof BlobSummarizerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BlobSummarizerError(
        `blob summarizer (${opts.model ?? '(default)'}) failed: ${message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  };
}
