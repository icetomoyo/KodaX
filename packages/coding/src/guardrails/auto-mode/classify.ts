/**
 * Auto-Mode Classifier Orchestrator — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Wires the classifier prompt + sideQuery + output parser into a single
 * `classify(...)` call. Caller supplies the rules, transcript, and the
 * tool-call action being classified; gets back a `ClassifyDecision`.
 *
 * Failure → decision mapping:
 *
 *   sideQuery.stopReason   parsedOutput   → ClassifyDecision
 *   ───────────────────────────────────────────────────────
 *   end_turn / max_tokens  block          → block (with reason)
 *   end_turn / max_tokens  allow          → allow
 *   end_turn / max_tokens  unparseable    → block (fail-closed)
 *   end_turn / max_tokens  + tool_use     → block (contract violation)
 *                          (sideQuery returns stopReason='error' here)
 *   timeout                —              → escalate (user confirms)
 *   aborted                —              → escalate (treated as caller-abort)
 *   error                  —              → escalate (5xx / 429 / network)
 *
 * Why fail-closed on unparseable but escalate on timeout/error:
 *   Unparseable = model spoke but didn't follow the contract → likely
 *     trying to bypass; treating as block is conservative and safe.
 *   Timeout/error = transient; blocking would punish the user for our
 *     infra hiccup. Escalating to a confirm dialog preserves user
 *     agency without putting safety on the line.
 */

import type { CostTracker } from '@kodax/ai';
import { KodaXBaseProvider, sideQuery } from '@kodax/ai';
import type { KodaXMessage } from '@kodax/ai';

import { buildClassifierPrompt } from './classifier-prompt.js';
import { parseClassifierOutput } from './parse-output.js';
import type { AutoRules } from './rules.js';

export interface ClassifyOptions {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly rules: AutoRules;
  readonly claudeMd?: string;
  readonly transcript: readonly KodaXMessage[];
  readonly action: string;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly costTracker?: CostTracker;
  /**
   * Optional setter — invoked once after `sideQuery` returns when the
   * classifier successfully recorded its token usage. The CostTracker is
   * immutable, so `sideQuery` produces a fresh tracker copy with the new
   * record; without this setter the recorded call is silently dropped.
   * Wired by the AutoModeToolGuardrail so the agent's tracker accumulates
   * classifier calls under role='auto_mode'.
   */
  readonly setCostTracker?: (next: CostTracker) => void;
}

export type ClassifyDecision =
  | { readonly kind: 'allow'; readonly reason: string }
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'escalate'; readonly reason: string };

const DEFAULT_TIMEOUT_MS = 8000;
const QUERY_SOURCE = 'auto_mode';

export async function classify(opts: ClassifyOptions): Promise<ClassifyDecision> {
  const prompt = buildClassifierPrompt({
    rules: opts.rules,
    claudeMd: opts.claudeMd,
    transcript: opts.transcript,
    action: opts.action,
  });

  const result = await sideQuery({
    provider: opts.provider,
    model: opts.model,
    system: prompt.system,
    messages: prompt.messages,
    reasoning: { mode: 'off' },
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
    querySource: QUERY_SOURCE,
    costTracker: opts.costTracker,
  });

  if (opts.setCostTracker && result.costTracker !== undefined && result.costTracker !== opts.costTracker) {
    opts.setCostTracker(result.costTracker);
  }

  switch (result.stopReason) {
    case 'end_turn':
    case 'max_tokens': {
      const decision = parseClassifierOutput(result.text);
      if (decision.kind === 'unparseable') {
        return {
          kind: 'block',
          reason: 'classifier output was unparseable (fail-closed)',
        };
      }
      return decision;
    }

    case 'timeout':
      return {
        kind: 'escalate',
        reason: `classifier timeout (${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms exceeded)`,
      };

    case 'aborted':
      // Caller-abort means the user cancelled the entire tool-call evaluation
      // (Ctrl-C upstream). Returning escalate would show a confirm dialog to a
      // user who has already requested cancellation. Re-throw an AbortError so
      // the caller's abort chain propagates cleanly.
      throw new DOMException('classify aborted', 'AbortError');

    case 'error':
    default: {
      const errMsg = result.error?.message ?? 'unknown error';
      // Tool-use contract violation comes through as 'error' with a recognizable
      // message; map to block instead of escalate (the model is misbehaving,
      // not the network).
      if (/tool_use/i.test(errMsg)) {
        return {
          kind: 'block',
          reason: `classifier returned tool_use block (contract violation)`,
        };
      }
      return {
        kind: 'escalate',
        reason: `classifier error: ${errMsg}`,
      };
    }
  }
}
