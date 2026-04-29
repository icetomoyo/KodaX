/**
 * FEATURE_101 invariant: `handoffLegality`.
 *
 * Admit-time DAG check: the handoff graph (manifest.handoffs + the
 * transitive closure of ctx.activatedAgents.handoffs) must be acyclic.
 * A cycle means the system can transfer ownership in a loop without
 * ever terminating — admission rejects.
 *
 * v1 algorithm: iterative DFS with explicit white/gray/black colouring.
 * Iterative (not recursive) because manifests with deep handoff chains
 * could blow the JS stack on certain runtimes — handing the search a
 * stack of our own keeps the bound predictable.
 *
 * Observe-time: no-op in v1. Cycle detection at admit time covers the
 * static graph; runtime handoff traversal is a separate concern handled
 * by the Runner's loop bound. We keep an `observe` stub registered so
 * future versions can add per-event bookkeeping (e.g. detect "agent X
 * already handed off this run, refusing second handoff") without a
 * registry migration.
 */

import type { Agent } from '../agent.js';
import type {
  AdmissionCtx,
  AgentManifest,
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
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

/**
 * Iterative DFS cycle detection. Returns the cycle path (closing edge
 * included) when a cycle is found, undefined otherwise.
 */
function findCycle(
  startName: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();

  // Per-frame: name + index of next child to visit + path to here.
  // `index` is intentionally mutable — the iterative DFS advances the child
  // pointer in place (see line `frame.index += 1`) instead of allocating a
  // new frame per child. This is the load-bearing optimization that lets
  // the search stay flat regardless of fan-out.
  type Frame = { readonly name: string; index: number; readonly path: readonly string[] };
  const stack: Frame[] = [{ name: startName, index: 0, path: [startName] }];
  colour.set(startName, GRAY);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const children = adjacency.get(frame.name) ?? [];
    if (frame.index >= children.length) {
      colour.set(frame.name, BLACK);
      stack.pop();
      continue;
    }
    const child = children[frame.index]!;
    frame.index += 1;
    const childColour = colour.get(child) ?? WHITE;
    if (childColour === GRAY) {
      // Back-edge: cycle from `child` to current frame, closing on `child`.
      const cycleStart = frame.path.indexOf(child);
      if (cycleStart === -1) {
        // Dead branch under the current single-start invariant: a GRAY
        // node always lies on `frame.path` because GRAY is set when the
        // node is pushed and cleared to BLACK when its frame is popped.
        // Kept as a defensive fallback so a future change that admits
        // multi-root traversal cannot silently corrupt the cycle path.
        return [...frame.path, child];
      }
      return [...frame.path.slice(cycleStart), child];
    }
    if (childColour === BLACK) continue;
    colour.set(child, GRAY);
    stack.push({ name: child, index: 0, path: [...frame.path, child] });
  }
  return undefined;
}

function admit(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult {
  // Build adjacency: manifest acts as one node; every activated agent
  // contributes its own outgoing edges. Names are the keys.
  const adjacency = new Map<string, readonly string[]>();
  adjacency.set(manifest.name, getOutgoingTargets(manifest));
  for (const [name, agent] of ctx.activatedAgents) {
    if (name === manifest.name) {
      // The manifest is being re-admitted under its own name — this would
      // be a registry collision, but admission v1 leaves duplicate-name
      // detection to the schema-validation step. Skip the activated copy
      // here so we audit the new manifest's edges, not the old one's.
      continue;
    }
    adjacency.set(name, getOutgoingTargets(agent));
  }

  const cycle = findCycle(manifest.name, adjacency);
  if (cycle) {
    return {
      ok: false,
      severity: 'reject',
      reason: `handoffLegality: handoff graph contains a cycle: ${cycle.join(' → ')}`,
    };
  }
  return { ok: true };
}

function observe(_event: RunnerEvent, _ctx: ObserveCtx): InvariantResult {
  // v1: static DAG check at admit-time is the only enforcement; observe
  // hooks the slot so future versions can add per-event bookkeeping.
  return { ok: true };
}

export const handoffLegality: QualityInvariant = {
  id: 'handoffLegality',
  description:
    'The handoff graph rooted at the manifest (including transitive references through activated agents) must be acyclic.',
  admit,
  observe,
};
