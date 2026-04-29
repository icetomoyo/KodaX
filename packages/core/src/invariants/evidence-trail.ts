/**
 * FEATURE_101 invariant: `evidenceTrail`.
 *
 * Mutations must leave evidence; the terminal deliverable verifies the
 * evidence trail is complete.
 *
 * Hooks:
 *   - observe(mutation_recorded): no-op in v1 — the runtime mutation
 *     tracker already records the file. Reserved for future "did the
 *     evidence_added event arrive within N tool calls of the mutation"
 *     timing checks.
 *   - assertTerminal(deliverable): if the run produced any mutations
 *     (deliverable.mutationCount > 0), at least one evidence artifact
 *     must accompany them. Empty `evidenceArtifacts` for a mutating run
 *     is a reject — the deliverable is unauditable.
 *
 * The threshold is intentionally coarse (any > 0 works): per-file
 * evidence is the @kodax/coding mutation tracker's job, not the Layer A
 * primitive's. We can tighten the rule once FEATURE_089 starts emitting
 * structured mutation→evidence pairings.
 */

import type {
  Deliverable,
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
  TerminalCtx,
} from '../admission.js';

function observe(_event: RunnerEvent, _ctx: ObserveCtx): InvariantResult {
  return { ok: true };
}

function assertTerminal(deliverable: Deliverable, _ctx: TerminalCtx): InvariantResult {
  if (deliverable.mutationCount > 0 && deliverable.evidenceArtifacts.length === 0) {
    return {
      ok: false,
      severity: 'reject',
      reason: `evidenceTrail: deliverable recorded ${deliverable.mutationCount} mutation(s) but produced no evidence artifacts`,
    };
  }
  return { ok: true };
}

export const evidenceTrail: QualityInvariant = {
  id: 'evidenceTrail',
  description:
    'Mutating runs must produce at least one evidence artifact; empty artifact list with non-zero mutationCount is a hard reject at terminal.',
  observe,
  assertTerminal,
};
