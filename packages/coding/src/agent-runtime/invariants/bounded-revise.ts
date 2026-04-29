/**
 * FEATURE_101 invariant: `boundedRevise`.
 *
 * Observe-time check: warns when the per-harness revise count climbs
 * past the system soft cap. The hard cap is enforced by the budget
 * controller in `task-engine/_internal/managed-task/budget.ts`; this
 * invariant adds an admission-trace breadcrumb so dispatch-eval can
 * track "how often does the LLM hit the revise wall".
 *
 * v1 threshold = `MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP + 1 = 3`
 * (one starter + two refinements). Crossing it doesn't abort the run —
 * the runtime keeps clamping at the hard cap — but it lights a warn
 * signal. The threshold is intentionally hardcoded here rather than
 * imported from `task-engine` constants: that constants module is
 * private to the task-engine, and admission is a separate concern.
 * Drift (e.g. the runtime cap changes to 4) means the warn signal
 * lights one round earlier than the hard cap, which is the desired
 * direction for a soft signal.
 *
 * No admit hook in v1 — `AgentManifest` doesn't carry `maxIterations`
 * as a top-level field today. The patch shape `clampMaxIterations`
 * exists but no v1 invariant emits it; tracking the gap explicitly
 * here so a future version can promote this invariant to admit+observe
 * once manifests declare iteration intent. This is a deliberate scope
 * deferral, NOT a contract hole — admission.ts §第一版 Invariant 清单
 * "boundedRevise: maxIterations ≤ system; runtime tracks revise count"
 * is satisfied by the runtime budget controller (the hard cap) plus
 * this observe-time soft warn.
 */

import type {
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
} from '@kodax/core';

const REVISE_WARN_THRESHOLD = 3;

function observe(event: RunnerEvent, _ctx: ObserveCtx): InvariantResult {
  if (event.kind !== 'revise_count') return { ok: true };
  if (event.count <= REVISE_WARN_THRESHOLD) return { ok: true };
  return {
    ok: false,
    severity: 'warn',
    reason: `boundedRevise: revise_count for harness="${event.harness}" reached ${event.count}, exceeding soft threshold ${REVISE_WARN_THRESHOLD}`,
  };
}

export const boundedRevise: QualityInvariant = {
  id: 'boundedRevise',
  description:
    'Per-harness revise count must stay within the soft threshold; crossings emit a warn signal for dispatch-eval (hard cap enforced by the budget controller).',
  observe,
};
