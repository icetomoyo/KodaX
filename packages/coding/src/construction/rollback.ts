/**
 * FEATURE_090 (v0.7.32) — Self-modify rollback orchestration.
 *
 * `rollbackSelfModify` is the runtime-level operation behind the
 * `kodax constructed rollback <name>` CLI. It restores the
 * previously-active version of a constructed agent by:
 *
 *   1. Identifying the current active version (the `status='active'`
 *      record with the most recent `activatedAt`).
 *   2. Identifying the rollback target — the next-most-recent
 *      `status='active'` record on disk for the same name. Earlier
 *      versions stay at `status='active'` after a self-modify
 *      activate (FEATURE_090 design intent: keep them as rollback
 *      targets), so the candidate set is whatever the file system
 *      has.
 *   3. Revoking the current active record (status → 'revoked',
 *      removed from the resolver via the unregister callback).
 *   4. Re-registering the target into the resolver. No policy gate,
 *      no LLM summary, no force-ask-user — rollback is its own
 *      operator-driven gate; the CLI invocation itself is the
 *      authorisation.
 *
 * We do NOT rewrite the target's `activatedAt`. The original
 * activation timestamps form a natural rollback chain: a second
 * rollback against the same agent picks the next-older active
 * record, and so on. Rewriting `activatedAt` would collapse the
 * history and break chained rollbacks.
 *
 * Why a dedicated function (not a thin wrapper around `activate()`):
 *
 *   - `activate()` triggers the FEATURE_090 self-modify detection
 *     (`sourceAgent === name && active prev exists`). In a rollback
 *     flow that detection would mis-fire and route through
 *     force-ask-user / LLM summary, asking the user for permission
 *     they already granted by invoking the rollback CLI.
 *   - `activate()` enforces the FEATURE_088 policy gate; the CLI
 *     surface configures `policy='reject'`, so it would always
 *     throw.
 *   - Rollback is read-modify-write across two persisted records
 *     (revoke + re-register) and benefits from atomic-ish ordering
 *     hidden behind one function rather than scattered across the
 *     CLI.
 *
 * Audit semantics: this module persists the resolver/disk changes
 * but does NOT write the audit entry — the CLI surface owns audit
 * attribution (records the OS user) and writes the
 * `self_modify_rolled_back` entry around the call. Keeps the
 * runtime's persistence concern separate from CLI-side attribution.
 */

import { Runner } from '@kodax/core';
import type { Agent } from '@kodax/core';

import { buildAdmissionManifest } from './admission-bridge.js';
import {
  listConstructedAgents,
  registerConstructedAgent,
} from './agent-resolver.js';
import {
  list as listArtifacts,
  revoke as revokeArtifact,
} from './runtime.js';
import type { AgentArtifact } from './types.js';

export interface RollbackResult {
  readonly agentName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly fromActivatedAt: number | undefined;
  readonly toActivatedAt: number | undefined;
}

export class RollbackError extends Error {
  readonly code: 'no-current-active' | 'no-rollback-target' | 'admission-failed';
  constructor(code: RollbackError['code'], message: string) {
    super(message);
    this.name = 'RollbackError';
    this.code = code;
  }
}

/**
 * Roll back `name` to its previous active version. Throws
 * `RollbackError` with a discriminated `code` so the CLI surface can
 * map onto exit codes / human-readable messages without string
 * matching.
 *
 * Pre-conditions:
 *   - At least two records on disk for the given name with
 *     `status='active'` and `activatedAt` set. The current is
 *     revoked; the next-most-recent becomes the active resolver
 *     entry.
 *   - The rollback target's manifest must still pass admission. We
 *     re-run admission so a target that was admissible at the time
 *     it originally activated but no longer is (system caps tightened,
 *     registered invariants changed) can't be silently re-registered.
 */
export async function rollbackSelfModify(name: string): Promise<RollbackResult> {
  const all = await listArtifacts('agent');
  const candidates = all
    .filter(
      (a): a is AgentArtifact =>
        a.kind === 'agent'
        && a.name === name
        && a.status === 'active'
        && typeof a.activatedAt === 'number',
    )
    .sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0));

  if (candidates.length === 0) {
    throw new RollbackError(
      'no-current-active',
      `No active version of '${name}' on disk — nothing to roll back from.`,
    );
  }
  if (candidates.length === 1) {
    throw new RollbackError(
      'no-rollback-target',
      `Only one active version of '${name}' (${candidates[0]!.version}) — no prior version to roll back to. Bump version + stage to author further changes.`,
    );
  }

  const current = candidates[0]!;
  const target = candidates[1]!;

  // Re-admit the rollback target (defense against system-cap drift
  // since it was originally activated). The activated-agents map
  // excludes `current` because we are about to revoke it.
  const manifest = buildAdmissionManifest({
    name: target.name,
    content: target.content,
  });
  const verdict = await Runner.admit(manifest, {
    activatedAgents: snapshotActivatedAgentsExcept(name),
    stagedAgents: new Map(),
  });
  if (!verdict.ok) {
    throw new RollbackError(
      'admission-failed',
      `Rollback target ${target.name}@${target.version} no longer admits: ${verdict.reason}.`,
    );
  }

  // Revoke the current active record (status → 'revoked' on disk;
  // resolver entry removed via the unregister callback stored at
  // activate time).
  await revokeArtifact(current.name, current.version);

  // Re-register the target in the resolver. We do NOT touch the
  // target's persisted record — its `status='active'` and original
  // `activatedAt` stay intact, preserving the rollback chain for
  // future invocations.
  registerConstructedAgent(target, {
    bindings: verdict.handle.invariantBindings,
    manifest: verdict.handle.manifest,
  });

  return {
    agentName: name,
    fromVersion: current.version,
    toVersion: target.version,
    fromActivatedAt: current.activatedAt,
    toActivatedAt: target.activatedAt,
  };
}

function snapshotActivatedAgentsExcept(excludeName: string): ReadonlyMap<string, Agent> {
  const map = new Map<string, Agent>();
  for (const agent of listConstructedAgents()) {
    if (agent.name === excludeName) continue;
    map.set(agent.name, agent);
  }
  return map;
}
