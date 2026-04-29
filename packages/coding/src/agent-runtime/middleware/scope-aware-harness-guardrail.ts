/**
 * FEATURE_106 Slice 1 — Scope-aware harness ToolGuardrail.
 *
 * Replaces the substrate-internal `buildMutationScopeReflection` middleware
 * (CAP-016) with a Layer A `ToolGuardrail.afterTool` so it can attach to
 * the AMA path's Scout / Generator agents (`coding-agents.ts`). CAP-016
 * runs only on the SA `defaultCodingAgent` because it lives inside the
 * substrate body — AMA agents bypass that path entirely. The Guardrail
 * runtime introduced in FEATURE_085 (v0.7.26) is the integration point
 * the AMA agents use, so re-expressing the policy as a Guardrail is the
 * cleanest way to surface it on AMA without re-plumbing the substrate.
 *
 * Behaviour:
 *
 *   - Hook: `afterTool`. We need to observe the *cumulative* mutation
 *     state, which only exists after the tool has run; `beforeTool`
 *     would fire on the first edit before any tracker delta is recorded.
 *   - Filters: only mutation tools (`isMutationTool`), only when the
 *     scope is significant (≥3 files OR ≥100 lines via
 *     `isMutationScopeSignificant`), only when Scout has NOT already
 *     emitted an H1/H2 verdict, and only once per run (idempotent via
 *     `tracker.reflectionInjected`).
 *   - Action: rewrite the tool result to append the harness-commitment
 *     hint pointing at the canonical `emit_scout_verdict` payload shape
 *     declared by `protocol-emitters.ts`. **Critical fix vs CAP-016**:
 *     the legacy text referenced `emit_managed_protocol`, a stale tool
 *     name; the new hint uses `emit_scout_verdict` so the LLM can act
 *     on it directly.
 *
 * Mounting: `coding-agents.ts` attaches this guardrail to `scoutSpec`
 * and `generatorSpec` only (Planner / Evaluator don't write multi-file
 * mutations as part of their role contract).
 *
 * Why a factory: the Layer A `GuardrailContext` is intentionally generic
 * (does not know about `mutationTracker` or the managed-protocol
 * payload). Factory captures those references via closure, mirroring
 * the `createToolResultTruncationGuardrail` pattern.
 */

import type {
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  RunnerToolResult,
  ToolGuardrail,
} from '@kodax/core';

import type { KodaXManagedProtocolPayload, ManagedMutationTracker } from '../../types.js';
import {
  buildMutationScopeReflectionHeader,
  isMutationScopeSignificant,
  isMutationTool,
} from './mutation-reflection.js';

export const SCOPE_AWARE_HARNESS_GUARDRAIL_NAME = 'scope-aware-harness';

/**
 * Reference holder for the managed-protocol payload. Mirrors the
 * `{ current: ... }` wrapper used by `tool-execution-context.ts` so
 * the guardrail observes mutations to the shared cell.
 */
export interface ManagedProtocolPayloadRef {
  readonly current: KodaXManagedProtocolPayload | undefined;
}

export interface ScopeAwareHarnessGuardrailDeps {
  /**
   * Mutation tracker shared with the substrate / managed-task runtime.
   * The guardrail reads `files`, `totalOps`, and toggles
   * `reflectionInjected` once per run for idempotency.
   */
  readonly mutationTracker: ManagedMutationTracker;
  /**
   * Reference cell holding the accumulated managed-protocol payload.
   * The guardrail reads `payloadRef.current?.scout?.confirmedHarness`
   * to skip the hint when Scout has already committed to H1/H2.
   */
  readonly payloadRef: ManagedProtocolPayloadRef;
}

/**
 * Build the harness-commitment hint text appended after a significant
 * multi-file mutation. Aligned with `protocol-emitters.ts` payload shape
 * for `emit_scout_verdict`. Composes the canonical scope header (file
 * list + line counts, shared with CAP-016) with the FEATURE_106 footer
 * — the canonical emit_scout_verdict example — replacing the legacy
 * stale `emit_managed_protocol` call-to-action.
 */
export function buildScopeAwareHarnessHint(tracker: ManagedMutationTracker): string {
  const header = buildMutationScopeReflectionHeader(tracker).trimEnd();
  const fileScope = [...tracker.files.keys()];
  const scopeArray = JSON.stringify(fileScope.slice(0, 4));
  return [
    header,
    '',
    'You are still in H0_DIRECT. Multi-file changes at this scale typically',
    'warrant H1 (review) or H2 (plan + review) before shipping.',
    '',
    '→ If this is execution that needs review:',
    '   emit_scout_verdict({',
    '     confirmed_harness: "H1_EXECUTE_EVAL",',
    '     summary: "...",',
    `     scope: ${scopeArray},`,
    '     review_files_or_areas: [...],',
    '   })',
    '',
    '→ If this needs structured planning (new feature, cross-module refactor):',
    '   emit_scout_verdict({ confirmed_harness: "H2_PLAN_EXECUTE_EVAL", ... })',
    '',
    '→ If you are confident this is a low-risk H0 task: continue, but the next',
    '   significant mutation will trigger this prompt again.',
  ].join('\n');
}

/**
 * Create the scope-aware harness ToolGuardrail. Attach to AMA Scout +
 * Generator specs via `Agent.guardrails` or pass through
 * `Runner.run({ guardrails: [...] })`.
 *
 * Returns `undefined` action ("allow") in every short-circuit branch so
 * tool error results, non-mutation tools, sub-threshold scope, and
 * already-injected runs all pass through untouched.
 */
export function createScopeAwareHarnessGuardrail(
  deps: ScopeAwareHarnessGuardrailDeps,
): ToolGuardrail {
  return {
    kind: 'tool',
    name: SCOPE_AWARE_HARNESS_GUARDRAIL_NAME,
    afterTool: async (
      call: RunnerToolCall,
      result: RunnerToolResult,
      _ctx: GuardrailContext,
    ): Promise<GuardrailVerdict> => {
      if (result.isError) return { action: 'allow' };
      if (!isMutationTool(call.name)) return { action: 'allow' };
      const tracker = deps.mutationTracker;
      if (tracker.reflectionInjected) return { action: 'allow' };
      if (!isMutationScopeSignificant(tracker)) return { action: 'allow' };
      const confirmed = deps.payloadRef.current?.scout?.confirmedHarness;
      if (confirmed && confirmed !== 'H0_DIRECT') return { action: 'allow' };

      tracker.reflectionInjected = true;
      const hint = buildScopeAwareHarnessHint(tracker);
      const rewritten: RunnerToolResult = {
        ...result,
        content: typeof result.content === 'string'
          ? `${result.content}${hint}`
          : `${String(result.content)}${hint}`,
      };
      return {
        action: 'rewrite',
        payload: rewritten,
        reason: `Scope reached ${tracker.files.size} files / ${[...tracker.files.values()].reduce((a, b) => a + b, 0)} lines without an emitted harness verdict; appended emit_scout_verdict hint.`,
      };
    },
  };
}
