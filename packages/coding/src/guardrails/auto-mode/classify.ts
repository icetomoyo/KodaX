/**
 * Auto-Mode Classifier Orchestrator — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Wires the reviewer prompt + sideQuery + output parser into a single
 * `classify(...)` call. Caller supplies the transcript and the
 * tool-call action being classified; gets back a `ClassifyDecision`.
 *
 * Failure → decision mapping:
 *
 *   sideQuery.stopReason   parsedOutput   → ClassifyDecision
 *   ───────────────────────────────────────────────────────
 *   end_turn / max_tokens  block          → confirm (with reason)
 *   end_turn / max_tokens  allow          → allow
 *   end_turn / max_tokens  unparseable    → retry, then failure
 *   end_turn / max_tokens  + tool_use     → retry, then failure
 *                          (sideQuery returns stopReason='error' here)
 *   timeout                —              → retry, then failure
 *   aborted                —              → throw AbortError to caller
 *   error                  —              → retry, then failure
 *
 * Every non-abort failure receives one immediate retry. The caller applies
 * its configured fail-closed result after the second failure; a valid model
 * concern blocks the current attempt with a concrete safer-route reason.
 */

import type {
  CostTracker,
  SideQueryDiagnostics,
  SideQueryResult,
} from '@kodax-ai/llm';
import { KodaXBaseProvider, sideQuery } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  buildClassifierPrompt,
  type BuildClassifierPromptInput,
} from './classifier-prompt.js';
import { parseClassifierOutput } from './parse-output.js';
import type {
  ClassifierObservedProtocol,
  ClassifierOutputWarningCode,
  ClassifierParseFailureCode,
} from './parse-output.js';
import type { ToolCallSignal } from './signals.js';
import type { PermissionIntentEvidence } from './permission-intent.js';
import { stripAssistantText } from './transcript-strip.js';
import {
  redactClassifierProjection,
  type ClassifierToolProjectionResolver,
} from '../../tools/classifier-projection.js';

export interface ClassifyOptions {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  /** @deprecated Legacy compatibility input. Auto rules are ignored. */
  readonly rules?: BuildClassifierPromptInput['rules'];
  readonly administratorPolicy?: string;
  readonly reviewPolicy?: string;
  readonly modelGuidance?: string;
  readonly claudeMd?: string;
  readonly transcript: readonly KodaXMessage[];
  readonly action: string;
  readonly intentEvidence?: PermissionIntentEvidence;
  /** Resolve canonical per-tool projections for safe historical context. */
  readonly getToolProjection?: ClassifierToolProjectionResolver;
  /**
   * FEATURE_158 (v0.7.39): static-analysis signals forwarded to the
   * classifier prompt. Empty / undefined preserves the FEATURE_092 prompt
   * shape (no `<signals>` block emitted). When supplied, the classifier
   * sees signals between `<transcript>` and `<action>` as informational
   * input — not verdicts.
   */
  readonly signals?: readonly ToolCallSignal[];
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

export type ClassifierFailureKind =
  | 'timeout'
  | 'provider_error'
  | 'contract_error'
  | 'input_budget';

export type ClassifierAttemptOutcome =
  | 'allow'
  | 'confirm'
  | ClassifierFailureKind;

export interface ClassifierAttemptDiagnostics {
  readonly attempt: number;
  readonly outcome: ClassifierAttemptOutcome;
  readonly diagnostics?: SideQueryDiagnostics;
  readonly observedProtocol?: ClassifierObservedProtocol;
  readonly parseFailureCode?: ClassifierParseFailureCode | 'tool_use';
  readonly outputWarnings?: readonly ClassifierOutputWarningCode[];
}

interface ClassifyDecisionDetails {
  readonly reason: string;
  /** Structured request metadata only; never includes prompt or response text. */
  readonly diagnostics?: SideQueryDiagnostics;
  readonly attempts: readonly ClassifierAttemptDiagnostics[];
}

export type ClassifyDecision =
  | ({ readonly kind: 'allow' } & ClassifyDecisionDetails)
  | ({ readonly kind: 'confirm' } & ClassifyDecisionDetails)
  | ({
    readonly kind: 'failure';
    readonly failureKind: ClassifierFailureKind;
  } & ClassifyDecisionDetails);

/**
 * The deadline includes connection setup, provider-side queueing, inference,
 * and any Retry-After/backoff handled by the provider adapter. Keep it bounded
 * so infrastructure failure reaches the caller's fail-closed path.
 */
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 90_000;
/** A retry gets a longer deadline because its expanded response budget can take longer to emit. */
export const DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS = 180_000;
/** The classifier returns three short XML tags; a coding-turn-sized budget is wasteful. */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 256;
/** A truncated first response gets one larger, still-bounded contract window. */
const CLASSIFIER_TRUNCATION_RETRY_OUTPUT_TOKENS = 1024;
/** Very large shell/script projections cannot be safely truncated and auto-approved. */
export const MAX_CLASSIFIER_ACTION_BYTES = 16 * 1024;
/** Defense in depth for rules, signals, and all serialized prompt sections. */
export const MAX_CLASSIFIER_PROMPT_BYTES = 32 * 1024;
/** One immediate retry absorbs transient queue, connection, and contract failures. */
export const CLASSIFIER_MAX_ATTEMPTS = 2;
const QUERY_SOURCE = 'auto_mode';

export async function classify(opts: ClassifyOptions): Promise<ClassifyDecision> {
  if (utf8Bytes(opts.action) > MAX_CLASSIFIER_ACTION_BYTES) {
    return {
      kind: 'failure',
      failureKind: 'input_budget',
      reason: `classifier input budget exceeded (action is larger than ${MAX_CLASSIFIER_ACTION_BYTES} bytes)`,
      attempts: [],
    };
  }
  const action = redactClassifierProjection(opts.action);

  const prompt = buildClassifierPrompt({
    rules: opts.rules,
    administratorPolicy: opts.administratorPolicy,
    reviewPolicy: opts.reviewPolicy,
    modelGuidance: opts.modelGuidance,
    claudeMd: opts.claudeMd,
    // Enforce the boundary at the classifier API itself so future callers
    // cannot accidentally bypass the session-history cap.
    transcript: opts.intentEvidence ? [] : stripAssistantText(opts.transcript, {
      getToolProjection: opts.getToolProjection,
    }),
    action,
    intentEvidence: opts.intentEvidence,
    signals: opts.signals,
  });
  if (classifierPromptBytes(prompt.system, prompt.messages) > MAX_CLASSIFIER_PROMPT_BYTES) {
    return {
      kind: 'failure',
      failureKind: 'input_budget',
      reason: `classifier input budget exceeded (prompt is larger than ${MAX_CLASSIFIER_PROMPT_BYTES} bytes)`,
      attempts: [],
    };
  }

  const attempts: ClassifierAttemptDiagnostics[] = [];
  let costTracker = opts.costTracker;
  let maxOutputTokens = CLASSIFIER_MAX_OUTPUT_TOKENS;

  for (let attempt = 1; attempt <= CLASSIFIER_MAX_ATTEMPTS; attempt += 1) {
    const timeoutMs = opts.timeoutMs
      ?? (attempt === 1
        ? DEFAULT_CLASSIFIER_TIMEOUT_MS
        : DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS);
    const result = await sideQuery({
      provider: opts.provider,
      model: opts.model,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens,
      timeoutMs,
      abortSignal: opts.abortSignal,
      querySource: QUERY_SOURCE,
      credentialPurpose: 'classifier',
      costTracker,
    });
    costTracker = result.costTracker ?? costTracker;

    const interpreted = interpretAttempt(result, timeoutMs);
    attempts.push({
      attempt,
      outcome: interpreted.outcome,
      diagnostics: result.diagnostics,
      ...(interpreted.observedProtocol !== undefined
        ? { observedProtocol: interpreted.observedProtocol }
        : {}),
      ...(interpreted.parseFailureCode !== undefined
        ? { parseFailureCode: interpreted.parseFailureCode }
        : {}),
      ...(interpreted.outputWarnings !== undefined
        ? { outputWarnings: interpreted.outputWarnings }
        : {}),
    });

    if (interpreted.outcome === 'allow' || interpreted.outcome === 'confirm') {
      commitCostTracker(opts, costTracker);
      return {
        kind: interpreted.outcome,
        reason: interpreted.reason,
        diagnostics: result.diagnostics,
        attempts,
      };
    }

    if (attempt === CLASSIFIER_MAX_ATTEMPTS) {
      commitCostTracker(opts, costTracker);
      return {
        kind: 'failure',
        failureKind: interpreted.outcome,
        reason: interpreted.reason,
        diagnostics: result.diagnostics,
        attempts,
      };
    }
    if (result.stopReason === 'max_tokens') {
      maxOutputTokens = CLASSIFIER_TRUNCATION_RETRY_OUTPUT_TOKENS;
    }
  }

  throw new Error('classifier retry loop exhausted unexpectedly');
}

interface InterpretedAttempt {
  readonly outcome: ClassifierAttemptOutcome;
  readonly reason: string;
  readonly observedProtocol?: ClassifierObservedProtocol;
  readonly parseFailureCode?: ClassifierParseFailureCode | 'tool_use';
  readonly outputWarnings?: readonly ClassifierOutputWarningCode[];
}

function interpretAttempt(
  result: SideQueryResult,
  timeoutMs: number,
): InterpretedAttempt {
  switch (result.stopReason) {
    case 'end_turn':
    case 'max_tokens': {
      // Canonical output is structured_v2, but Runtime remains a dual-reader
      // during rollout so providers that emit the prior valid contract do not
      // turn a semantic allow/ask decision into an infrastructure failure.
      const decision = parseClassifierOutput(result.text);
      if (decision.kind === 'unparseable') {
        return {
          outcome: 'contract_error',
          reason: `classifier output was unparseable (contract violation: ${decision.failureCode})`,
          observedProtocol: decision.observedProtocol,
          parseFailureCode: decision.failureCode,
        };
      }
      return {
        outcome: decision.kind === 'block' ? 'confirm' : 'allow',
        reason: decision.reason,
        observedProtocol: decision.protocol,
        ...(decision.warnings !== undefined
          ? { outputWarnings: decision.warnings }
          : {}),
      };
    }

    case 'timeout':
      return {
        outcome: 'timeout',
        reason: `classifier timeout (${formatSideQueryDiagnostics(
          result.diagnostics,
          timeoutMs,
        )})`,
      };

    case 'aborted':
      throw new DOMException('classify aborted', 'AbortError');

    case 'error':
    default: {
      const errMsg = result.error?.message ?? 'unknown error';
      return /tool_use/i.test(errMsg)
        ? {
          outcome: 'contract_error',
          reason: 'classifier returned tool_use (contract violation)',
          parseFailureCode: 'tool_use',
        }
        : {
          outcome: 'provider_error',
          reason: `classifier error: provider request failed (${formatSideQueryDiagnostics(
            result.diagnostics,
            timeoutMs,
          )})`,
        };
    }
  }
}

function commitCostTracker(
  opts: ClassifyOptions,
  next: CostTracker | undefined,
): void {
  if (opts.setCostTracker && next !== undefined && next !== opts.costTracker) {
    opts.setCostTracker(next);
  }
}

function formatSideQueryDiagnostics(
  value: SideQueryDiagnostics | undefined,
  fallbackTimeoutMs: number,
): string {
  if (!value) return `${fallbackTimeoutMs}ms exceeded`;
  return [
    `provider=${value.provider}`,
    `model=${value.model}`,
    `timeoutMs=${value.timeoutMs}`,
    `elapsedMs=${value.elapsedMs}`,
    `promptBytes=${value.promptBytes}`,
    ...(value.firstUpstreamEventMs !== undefined
      ? [`firstUpstreamEventMs=${value.firstUpstreamEventMs}`]
      : []),
    ...(value.firstThinkingDeltaMs !== undefined
      ? [`firstThinkingDeltaMs=${value.firstThinkingDeltaMs}`]
      : []),
    ...(value.firstTextDeltaMs !== undefined
      ? [`firstTextDeltaMs=${value.firstTextDeltaMs}`]
      : []),
    `retries=${value.retryCount}`,
    `retryWaitMs=${value.retryWaitMs}`,
    `phase=${value.terminalPhase}`,
  ].join(', ');
}

function classifierPromptBytes(system: string, messages: readonly KodaXMessage[]): number {
  return utf8Bytes(system) + utf8Bytes(JSON.stringify(messages));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
