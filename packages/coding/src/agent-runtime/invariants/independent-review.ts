/**
 * FEATURE_101 invariant: `independentReview`.
 *
 * Verifier-binding invariant: when a manifest's role topology includes
 * a Generator (mutation-producing) role, an Evaluator must also be
 * reachable so the generator's output is independently verified. v1
 * uses agent name conventions (`generator` / `evaluator`) — the
 * canonical role names declared by `@kodax/core/task-engine-agents.ts`.
 *
 * Hooks:
 *   - admit: walk the reachable handoff graph from the manifest. If
 *     any node has name === 'generator', some node must also have name
 *     === 'evaluator'. Single-role manifests (scout / planner / direct
 *     execution) admit unconditionally.
 *   - assertTerminal: if the deliverable recorded mutations, it must
 *     carry a `verdict` field (the evaluator's accept/revise/blocked
 *     emission). A mutating run with no verdict means the generator
 *     bypassed verification — reject.
 *
 * The verifier-can't-read-generator-reasoning contract from
 * FEATURE_101 §verifier separation lives at the message-routing layer
 * (handoff inputFilter); admission's job here is to ensure the role
 * pairing exists, not to police the message flow.
 */

import type { Agent } from '@kodax/core';
import type {
  AdmissionCtx,
  AgentManifest,
  Deliverable,
  InvariantResult,
  QualityInvariant,
  TerminalCtx,
} from '@kodax/core';

const GENERATOR_NAME = 'generator';
const EVALUATOR_NAME = 'evaluator';

function reachableNames(
  start: AgentManifest,
  activatedAgents: ReadonlyMap<string, Agent>,
  stagedAgents: ReadonlyMap<string, Agent>,
): ReadonlySet<string> {
  const seen = new Set<string>([start.name]);
  const queue: Agent[] = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const handoffs = node.handoffs;
    if (!handoffs) continue;
    for (const h of handoffs) {
      const target = h.target;
      const tname = target?.name;
      if (typeof tname !== 'string' || tname.length === 0) continue;
      if (seen.has(tname)) continue;
      seen.add(tname);
      // FEATURE_101 v0.7.31.2 — same-batch stagedAgents fallback (mirrors
      // `handoffLegality`'s authoritative-resolution rule). Activated
      // copies win; otherwise prefer the staged manifest over the inline
      // handoff target (which may be a stub captured before the staged
      // manifest's handoffs were scaffolded). Inline target is the last
      // resort so a manifest whose generator/evaluator pair is split
      // across the same batch still admits.
      const activated = activatedAgents.get(tname);
      const staged = !activated ? stagedAgents.get(tname) : undefined;
      if (activated) queue.push(activated);
      else if (staged) queue.push(staged);
      else if (target) queue.push(target as Agent);
    }
  }
  return seen;
}

function admit(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult {
  const names = reachableNames(manifest, ctx.activatedAgents, ctx.stagedAgents);
  const hasGenerator = names.has(GENERATOR_NAME);
  if (!hasGenerator) return { ok: true };
  const hasEvaluator = names.has(EVALUATOR_NAME);
  if (hasEvaluator) return { ok: true };
  return {
    ok: false,
    severity: 'reject',
    reason: `independentReview: manifest's reachable handoff graph includes a generator role but no evaluator — verifier binding missing`,
  };
}

function assertTerminal(deliverable: Deliverable, _ctx: TerminalCtx): InvariantResult {
  if (deliverable.mutationCount === 0) return { ok: true };
  if (deliverable.verdict !== undefined) return { ok: true };
  return {
    ok: false,
    severity: 'reject',
    reason: `independentReview: deliverable recorded ${deliverable.mutationCount} mutation(s) but produced no evaluator verdict — independent review skipped`,
  };
}

export const independentReview: QualityInvariant = {
  id: 'independentReview',
  description:
    'Generator-bearing manifests must include an evaluator in the handoff graph; mutating deliverables must carry an evaluator verdict at terminal.',
  admit,
  assertTerminal,
};
