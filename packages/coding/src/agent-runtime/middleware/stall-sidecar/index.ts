

import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { RunnerToolObserver } from '@kodax-ai/agent';

import {
  createStallOrchestrator,
  type StallOrchestrator,
} from './orchestrator.js';
import type { SidecarVerdict } from './sidecar.js';
import type {
  StallDetector,
  StallSignal,
} from '../../../multi-instance/stall-detector.js';
import {
  REPORT_TOOL,
  SIDECAR_SYSTEM_PROMPT,
} from './prompts.js';

export interface CreateStallSidecarToolObserverOptions {
  /** Provider used for the L2 sidecar LLM call. Production wiring
   *  (`runner-driven.ts`) resolves this via `resolveStallSidecarProvider`
   *  — default inherit-main with `KODAX_STALL_PROVIDER` +
   *  `KODAX_STALL_MODEL` env override. Tests can pass a fake provider
   *  directly. */
  readonly provider: KodaXBaseProvider;
  /** Specific model id on the provider. When omitted, provider's
   *  registered default model is used. */
  readonly model?: string;
  /** L1 rule-based detector (lives in `multi-instance/stall-detector.ts`
   *  — not moved into this directory because its killswitch
   *  (`KODAX_STALL_DETECT=0`) is detector-scoped, not sidecar-scoped). */
  readonly detector: StallDetector;
  /** Observability sink — fires every time a sidecar verdict resolves
   *  (whether isStuck true or false). Phase C wires the env-gated
   *  `stallSidecarFired` ObserverBridge call through this. `elapsedMs`
   *  is wall-clock from sidecar invocation kickoff to verdict
   *  resolution; captured by the orchestrator (non-awaited path). */
  readonly onVerdict?: (
    signal: StallSignal,
    verdict: SidecarVerdict,
    elapsedMs: number,
  ) => void;
  /** Sidecar timeout in ms. Default 5000 (F178 eval baseline). */
  readonly timeoutMs?: number;
}

/**
 * Returned by `createStallSidecarToolObserver`. `observer` slots into
 * any agent-layer `RunnerToolObserver` consumer; `reset` is called by
 * the coding layer on compaction post-hook (the one lifecycle event
 * the agent layer does not expose through the observer interface).
 */
export interface StallSidecarHandle {
  readonly observer: RunnerToolObserver;
  readonly reset: () => void;
}

/**
 * Build a `RunnerToolObserver` that runs the FEATURE_178 stall sidecar.
 * Phase D's `composeToolObservers` helper will let callers chain this
 * before their permission / extension observers without manual inlining;
 * in Phase A the coding layer composes by hand.
 */
export function createStallSidecarToolObserver(
  options: CreateStallSidecarToolObserverOptions,
): StallSidecarHandle {
  const orchestrator: StallOrchestrator = createStallOrchestrator({
    detector: options.detector,
    provider: options.provider,
    model: options.model,
    systemPrompt: SIDECAR_SYSTEM_PROMPT,
    reportTool: REPORT_TOOL,
    timeoutMs: options.timeoutMs,
    onVerdict: options.onVerdict,
  });

  const observer: RunnerToolObserver = {
    beforeTool: async (call) => {
      // Pending-nudge consumption — when the previous tool's onToolCall
      // fired an L1 signal AND the L2 sidecar returned isStuck=true, the
      // nudge text is sitting in the orchestrator. Returning it as a
      // string blocks a matching repeated call with the nudge as its synthesized
      // tool_result — the model sees the nudge instead of the actual
      // tool output and rethinks.
      const pendingNudge = orchestrator.consumePendingNudge(call);
      if (pendingNudge !== undefined) {
        return pendingNudge;
      }
      return true;
    },
    onToolCall: (call) => {
      // Record into detector + transcript buffer; fires L2 sidecar
      // non-awaited when stall is detected. Verdict surfaces on the
      // next beforeTool call via consumePendingNudge() — one-cycle
      // latency by design (`stall-orchestrator.ts` doc-comment).
      orchestrator.recordToolUse(call);
    },
    onToolResult: (call, result) => {
      // String-coerce so the orchestrator's transcript buffer stays
      // text-only — the sidecar prompt only reads text. Mirrors the
      // pre-FEATURE_187 coercion that used to live inline in
      // `runner-driven.ts:onToolResult`.
      const content =
        typeof result.content === 'string'
          ? result.content
          : '[non-text content]';
      orchestrator.recordToolResult({ id: call.id }, content);
    },
  };

  return {
    observer,
    reset: () => orchestrator.reset(),
  };
}

// Minimal public surface — the factory + its option/return types only.
// `SidecarVerdict` is re-exported because the `onVerdict` callback in
// `CreateStallSidecarToolObserverOptions` references it, so any caller
// supplying a typed callback needs the shape. Everything else (raw
// `invokeStallSidecar`, `createStallOrchestrator`, prompt assets,
// `TRANSCRIPT_WINDOW`, `ALLOWED_SUGGESTED_TOOLS`, `StallOrchestrator*`
// types, `StallSidecarOptions`, `SidecarVerdictTrace`) is intentionally
// NOT re-exported — those are implementation details whose invariants
// can only be safely honoured through this factory. Tests + future
// phase wiring import them via direct `./sidecar.js` / `./prompts.js`
// subpaths when truly needed.
export type { SidecarVerdict } from './sidecar.js';
