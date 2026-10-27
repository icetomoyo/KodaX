/**
 * FEATURE_178 (v0.7.42) — runtime orchestrator wiring L1 detector → L2
 * sidecar → nudge injection.
 *
 * Building block consumed by `runner-driven.ts` (commit 4/4). Separated
 * from the runner so its lifecycle / state shape is unit-testable in
 * isolation.
 *
 * **Flow** (one tool call):
 *   1. `recordToolUse(call)` records the assistant tool_use into the
 *      detector (L1). On a stall signal, snapshots the recent transcript
 *      buffer and fires the sidecar invocation as a non-awaited Promise.
 *   2. The Promise resolves with a `SidecarVerdict`. If `isStuck=true`,
 *      the nudge text is stored in `pendingNudgeRef`.
 *   3. `consumePendingNudge(call)` is called by each tool call's
 *      `beforeTool` gate. If a nudge matches that call, it's returned as the
 *      block string — synthesizing the nudge as the tool_result text
 *      the model sees. The redundant tool dispatch is suppressed for
 *      that one call; unrelated calls continue. Existing progress boundaries
 *      invalidate queued and in-flight verdicts about preceding work.
 *   4. `recordToolResult(call, content)` records the tool_result into
 *      the transcript buffer so the next sidecar invocation has up-to-
 *      date evidence.
 *   5. `reset()` clears all state — called on compaction post-hook
 *      alongside detector reset.
 *
 * **One-cycle latency**: we let the FIRST repeated call run because
 * `recordToolUse` returns sync (no awaiting in `onToolCall`). The
 * sidecar verdict arrives later, for a matching call's `beforeTool` gate
 * to consume if repetition continues. Unrelated calls proceed normally;
 * an existing progress boundary expires the earlier inspection verdict.
 *
 * **Why not block in beforeTool**: blocking the first redundant tool
 * with an awaited sidecar call would add up to 5s to that call's
 * latency. With async fire-and-forget the cost is amortised — the
 * sidecar runs in parallel with the tool, and only a matching repeated
 * call sees the verdict-driven block.
 */

import type {
  KodaXMessage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { KodaXBaseProvider } from '@kodax-ai/llm';

import {
  invokeStallSidecar,
  type SidecarVerdict,
} from './sidecar.js';
import { buildSidecarUserMessage } from './prompts.js';
import { isProbeProgressBoundary, matchesStallSignal, type StallDetector, type StallSignal } from '../../../multi-instance/stall-detector.js';

/**
 * How many recent tool turns the orchestrator keeps for the sidecar
 * transcript. 8 turns = 16 messages (tool_use + tool_result pair per
 * turn). The F178 eval cases used 4-12 turns of history — 8 sits
 * comfortably in that range without bloating the sidecar prompt.
 */
export const TRANSCRIPT_WINDOW = 16;

export interface StallOrchestratorOptions {
  readonly detector: StallDetector;
  readonly provider: KodaXBaseProvider;
  /**
   * Specific model id on the provider. When omitted, the provider's
   * registered default model is used. FEATURE_187 Phase B threads this
   * through from `resolveStallSidecarProvider()` so `KODAX_STALL_MODEL`
   * env override takes effect at the underlying `provider.stream` call.
   */
  readonly model?: string;
  readonly systemPrompt: string;
  readonly reportTool: KodaXToolDefinition;
  /** Sidecar timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /**
   * Optional verdict callback for observability — fires every time a
   * sidecar verdict resolves (whether isStuck true or false). Used by
   * integration tests; production wiring uses this for FEATURE_187
   * Phase C opt-in stall log (`KODAX_STALL_LOG=1` gate inside the
   * factory's onVerdict wrapping). `elapsedMs` is wall-clock time from
   * sidecar invocation kickoff to verdict resolution — captured by the
   * orchestrator since the sidecar runs non-awaited from `recordToolUse`.
   */
  readonly onVerdict?: (
    signal: StallSignal,
    verdict: SidecarVerdict,
    elapsedMs: number,
  ) => void;
}

export interface StallOrchestrator {
  /**
   * Record a tool_use into the detector + transcript buffer. If the
   * detector fires a stall signal, kicks off the sidecar invocation
   * (non-awaited). Returns true when a stall signal was emitted (the
   * caller does not need to act on it — the orchestrator handles
   * verdict storage internally).
   */
  recordToolUse(call: { name: string; id: string; input: Record<string, unknown> }): boolean;

  /**
   * Record the tool_result string for a tool_use already passed to
   * `recordToolUse`. Used to enrich the transcript buffer the sidecar
   * sees.
   */
  recordToolResult(call: { id: string }, content: string): void;

  /**
   * Consume a pending nudge only for its exact repeated call or probe family.
   * Unrelated calls leave it pending; existing progress boundaries invalidate
   * it in recordToolUse. Called by the beforeTool gate.
   */
  consumePendingNudge(call: { name: string; input: Record<string, unknown> }): string | undefined;

  /**
   * Drop all state. Called on compaction post-hook alongside
   * detector.reset() and readFileStateCache.clear().
   */
  reset(): void;

  /** Diagnostic / test accessor. */
  readonly debug: {
    readonly transcriptSize: () => number;
    readonly hasPendingNudge: () => boolean;
    readonly pendingSidecarPromises: () => readonly Promise<unknown>[];
  };
}

export function createStallOrchestrator(
  options: StallOrchestratorOptions,
): StallOrchestrator {
  const transcript: KodaXMessage[] = [];
  let pendingNudge: { text: string; signal: Extract<StallSignal, { kind: 'stall' }> } | undefined;
  let generation = 0;
  let progressGeneration = 0;
  let inFlightSignal: Extract<StallSignal, { kind: 'stall' }> | undefined;
  const pendingPromises: Promise<unknown>[] = [];

  function pushTranscript(message: KodaXMessage): void {
    transcript.push(message);
    if (transcript.length > TRANSCRIPT_WINDOW) {
      transcript.splice(0, transcript.length - TRANSCRIPT_WINDOW);
    }
  }

  function snapshotTranscript(): readonly KodaXMessage[] {
    return transcript.map((m) => ({ ...m }));
  }

  return {
    recordToolUse(call) {
      // Reuse the detector's progress boundaries. Planning alone does not
      // discard an inspection warning, but an actual repair must not receive
      // a delayed verdict about inspection that preceded it.
      if (isProbeProgressBoundary(call.name, call.input)) {
        if (pendingNudge && !matchesStallSignal(pendingNudge.signal, call.name, call.input)) pendingNudge = undefined;
        if (inFlightSignal && !matchesStallSignal(inFlightSignal, call.name, call.input)) progressGeneration++;
      }
      const useBlock: KodaXToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      };
      pushTranscript({ role: 'assistant', content: [useBlock] });

      const signal = options.detector.recordToolUse(call.name, call.input);
      if (signal.kind !== 'stall') return false;
      if (inFlightSignal) return true;

      const snapshot = snapshotTranscript();
      const userMessage = buildSidecarUserMessage({
        signalEnvelope: signal.envelope,
        recentMessages: snapshot,
      });

      // Capture sidecar kickoff time so the `onVerdict` callback can
      // surface elapsedMs (FEATURE_187 Phase C opt-in observability).
      // Wall-clock includes provider.stream + parse + Levenshtein
      // fuzzy match
      // line reports.
      const sidecarStartedAt = Date.now();
      const signalGeneration = generation;
      const signalProgressGeneration = progressGeneration;
      inFlightSignal = signal;
      const promise = invokeStallSidecar({
        provider: options.provider,
        model: options.model,
        userMessage,
        systemPrompt: options.systemPrompt,
        reportTool: options.reportTool,
        timeoutMs: options.timeoutMs,
      })
        .then((verdict) => {
          if (signalGeneration !== generation) return;
          const elapsedMs = Date.now() - sidecarStartedAt;
          options.onVerdict?.(signal, verdict, elapsedMs);
          if (verdict.isStuck && verdict.nudge && signalProgressGeneration === progressGeneration) {
            pendingNudge = { text: verdict.nudge, signal };
          }
        })
        .catch(() => {
          // invokeStallSidecar already swallows all errors and returns
          // safe-default verdicts. Defensive belt-and-suspenders catch
          // here in case the contract ever changes.
        })
        .finally(() => {
          if (signalGeneration === generation) inFlightSignal = undefined;
        });
      pendingPromises.push(promise);
      return true;
    },

    recordToolResult(call, content) {
      pushTranscript({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            content,
          },
        ],
      });
    },

    consumePendingNudge(call) {
      if (!pendingNudge || !matchesStallSignal(pendingNudge.signal, call.name, call.input)) return undefined;
      const nudge = pendingNudge;
      pendingNudge = undefined;
      return nudge.text;
    },

    reset() {
      transcript.length = 0;
      pendingNudge = undefined;
      generation += 1;
      progressGeneration = 0;
      inFlightSignal = undefined;
      // Existing promises may resolve naturally; the generation fence makes
      // verdicts from the pre-compaction transcript a no-op.
    },

    debug: {
      transcriptSize: () => transcript.length,
      hasPendingNudge: () => pendingNudge !== undefined,
      pendingSidecarPromises: () => [...pendingPromises],
    },
  };
}
