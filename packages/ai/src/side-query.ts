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
 *   - independent timeout (default 30s; classifier overrides to ~8s)
 *   - independent cost bucket via querySource (mapped to TokenUsageRecord.role)
 *
 * Failure handling: never throws. Timeout, abort, provider error, and
 * unexpected tool_use all produce a result with stopReason='timeout' /
 * 'aborted' / 'error' so callers implement their own degradation.
 */

import type {
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXTokenUsage,
} from './types.js';
import { KodaXBaseProvider } from './providers/base.js';
import { type CostTracker, recordUsage } from './cost-tracker.js';

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
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly querySource: string;
  readonly costTracker?: CostTracker;
}

export interface SideQueryResult {
  readonly text: string;
  readonly usage: KodaXTokenUsage;
  readonly costTracker?: CostTracker;
  readonly stopReason: SideQueryStopReason;
  readonly error?: Error;
}

const EMPTY_USAGE: KodaXTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const DEFAULT_TIMEOUT_MS = 30_000;

export async function sideQuery(req: SideQueryRequest): Promise<SideQueryResult> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  try {
    const result = await req.provider.stream(
      [...req.messages],
      [],
      req.system,
      req.reasoning ?? { mode: 'off' },
      { modelOverride: req.model },
      controller.signal,
    );

    const usage = result.usage ?? EMPTY_USAGE;
    const textBlocks = result.textBlocks ?? [];
    const toolBlocks = result.toolBlocks ?? [];
    const text = textBlocks.map((b) => b.text).join('');

    if (toolBlocks.length > 0) {
      return {
        text,
        usage,
        costTracker: req.costTracker,
        stopReason: 'error',
        error: new Error(
          `sideQuery: provider returned ${toolBlocks.length} tool_use block(s); sideQuery expects text-only output`,
        ),
      };
    }

    let costTracker = req.costTracker;
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

    return {
      text,
      usage,
      costTracker,
      stopReason: mapStopReason(result.stopReason),
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
      costTracker: req.costTracker,
      stopReason,
      error,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (req.abortSignal) {
      req.abortSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

// Provider stop reasons we recognize:
//   'max_tokens' → output truncation (caller may want to retry with larger budget)
//   'end_turn' / 'stop_sequence' / undefined → normal completion
//   'tool_use' → unreachable here (toolBlocks check above already errored out)
// Any unknown future value is conservatively treated as a normal completion;
// the caller's parsing of `text` is the authoritative success signal.
function mapStopReason(raw: string | undefined): SideQueryStopReason {
  if (raw === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}
