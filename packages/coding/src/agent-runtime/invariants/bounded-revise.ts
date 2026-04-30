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
 * No admit hook in v1 — and that stays true in v0.7.31.2 even though
 * the surrounding plumbing now supports it. v0.7.31.2 added
 * `AgentManifest.maxIterations` (admission.ts) plus the
 * `applyManifestPatch` apply branch for `clampMaxIterations`, and
 * `Runner.run` reads the post-clamp manifest cap via
 * `getAdmittedAgentBindings`. What's still missing is an admit-time
 * SOURCE: no v1 invariant inspects manifest content and emits a
 * `clampMaxIterations` patch. So the field exists, the apply path
 * exists, and the runtime enforcement exists — but `boundedRevise`
 * itself stays observe-only by design (its v1 contract is the
 * runtime soft warn, not admit-time clamping). A future version may
 * promote this invariant to admit+observe once we have a concrete
 * policy ("manifests declaring revise-heavy roles get clamped to N
 * iterations"). admission.ts §第一版 Invariant 清单 "boundedRevise:
 * maxIterations ≤ system; runtime tracks revise count" is satisfied
 * by the runtime budget controller (the hard cap) plus this
 * observe-time soft warn.
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
