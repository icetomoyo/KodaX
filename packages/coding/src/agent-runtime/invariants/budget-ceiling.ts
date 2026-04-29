/**
 * FEATURE_101 invariant: `budgetCeiling`.
 *
 * Admit-time check: manifest.maxBudget must not exceed systemCap.maxBudget.
 * If it does, clamp via a `clampMaxBudget` patch — the manifest is
 * admitted with the lower value.
 *
 * Why this lives in @kodax/coding (not @kodax/core): the system budget
 * baseline is `DEFAULT_MANAGED_WORK_BUDGET = 200` declared in the coding
 * task-engine constants. Admission's job is to express the same policy
 * declaratively at the manifest layer; the actual runtime budget
 * controller in `task-engine/_internal/managed-task/budget.ts` enforces
 * iteration deductions per turn. This invariant adds the up-front
 * "your declared budget is over the cap" feedback to LLM-generated
 * manifests so they don't request 100k iterations and discover at
 * runtime that they get 200.
 *
 * v1 only handles maxBudget; clampMaxIterations is the `boundedRevise`
 * invariant's territory (separate-concern). Pure function.
 */

import type {
  AdmissionCtx,
  AgentManifest,
  InvariantResult,
  QualityInvariant,
} from '@kodax/core';

function admit(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult {
  if (typeof manifest.maxBudget !== 'number') return { ok: true };
  if (manifest.maxBudget <= ctx.systemCap.maxBudget) return { ok: true };
  return {
    ok: false,
    severity: 'clamp',
    reason: `budgetCeiling: manifest.maxBudget=${manifest.maxBudget} exceeds systemCap.maxBudget=${ctx.systemCap.maxBudget}`,
    patch: { clampMaxBudget: ctx.systemCap.maxBudget },
  };
}

export const budgetCeiling: QualityInvariant = {
  id: 'budgetCeiling',
  description:
    'manifest.maxBudget must be ≤ systemCap.maxBudget; over-cap declarations are clamped down to the cap.',
  admit,
};
