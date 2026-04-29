/**
 * FEATURE_101 invariant: `finalOwner`.
 *
 * Admit-only check: the manifest must designate a final owner. v1 heuristic:
 *
 *   - manifest.name is non-empty (schema validation already enforces, but
 *     re-checking here keeps the invariant self-contained), and
 *   - if the manifest declares handoffs, the handoff graph (manifest +
 *     ctx.activatedAgents) must contain at least one terminal node — an
 *     agent with no outgoing handoffs. If every node has an outgoing
 *     handoff, the deliverable has no resting place; admit rejects.
 *
 * The check is intentionally lightweight: deeper graph properties (single
 * sink, dominator analysis) are noise for v1 and would burn invariant
 * budget on hypothetical multi-role topologies that don't ship in
 * v0.7.31. We can sharpen the rule when FEATURE_089 starts emitting
 * richer manifests.
 *
 * Pure function — no I/O, no shared mutable state.
 */

import type { Agent } from '../agent.js';
import type {
  AdmissionCtx,
  AgentManifest,
  InvariantResult,
  QualityInvariant,
} from '../admission.js';

function getOutgoingTargets(agent: Agent): readonly string[] {
  if (!agent.handoffs || agent.handoffs.length === 0) return [];
  const targets: string[] = [];
  for (const h of agent.handoffs) {
    const name = h.target?.name;
    if (typeof name === 'string' && name.length > 0) {
      targets.push(name);
    }
  }
  return targets;
}

function admit(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult {
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    return {
      ok: false,
      severity: 'reject',
      reason: 'finalOwner: manifest.name must be a non-empty string',
    };
  }

  const manifestTargets = getOutgoingTargets(manifest);
  if (manifestTargets.length === 0) {
    // No handoffs: the manifest itself is the terminal owner.
    return { ok: true };
  }

  // Walk the reachable handoff graph (manifest + activatedAgents). If any
  // reachable node has no outgoing handoffs, that node is a terminal owner.
  // If every reachable node hands off again, no owner exists → reject.
  const visited = new Set<string>([manifest.name]);
  const queue: string[] = [...manifestTargets];
  let foundTerminal = false;

  while (queue.length > 0) {
    const nextName = queue.shift()!;
    if (visited.has(nextName)) continue;
    visited.add(nextName);

    const next = ctx.activatedAgents.get(nextName);
    if (!next) {
      // Target not activated yet — treat as a terminal candidate. Admission
      // can't see beyond the manifest, and a not-yet-activated target may
      // legitimately be the final owner once it admits.
      foundTerminal = true;
      continue;
    }
    const outgoing = getOutgoingTargets(next);
    if (outgoing.length === 0) {
      foundTerminal = true;
      continue;
    }
    for (const t of outgoing) {
      if (!visited.has(t)) queue.push(t);
    }
  }

  if (!foundTerminal) {
    return {
      ok: false,
      severity: 'reject',
      reason: `finalOwner: handoff graph from "${manifest.name}" has no terminal owner — every reachable agent declares an outgoing handoff`,
    };
  }
  return { ok: true };
}

export const finalOwner: QualityInvariant = {
  id: 'finalOwner',
  description:
    'Manifest must designate a final owner — the handoff graph from this manifest must reach at least one agent with no further outgoing handoffs.',
  admit,
};
