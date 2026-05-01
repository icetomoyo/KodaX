/**
 * FEATURE_090 (v0.7.32) — Coding Agent internal tool for self-modify staging.
 *
 * `stage_self_modify` is the explicit entry point an active constructed
 * agent uses to publish a new version of *itself*. The split from
 * `stage_agent_construction` (FEATURE_089) is deliberate:
 *
 *   - `stage_agent_construction` creates a NEW agent under a different
 *     name. The artifact's `name` must not collide with an active
 *     constructed agent.
 *   - `stage_self_modify` creates a new version of the CALLER. The
 *     artifact's `name` must equal `sourceAgent`, and an active
 *     version must already exist on disk.
 *
 * Why two tools instead of name-based auto-detection inside
 * `stage_agent_construction`:
 *
 *   - LLM-friendly: predictable, explicit semantics. The LLM picks
 *     the tool that matches its intent rather than discovering at
 *     reject-time that the chosen tool refused.
 *   - Audit clarity: `stage_self_modify` writes
 *     `self_modify_staged` / `self_modify_rejected` audit entries.
 *     A unified entry tool would have to discriminate post-hoc, with
 *     a higher chance of an event slipping through unrecorded.
 *   - Per-agent disable: revoking an agent's `stage_self_modify`
 *     capability via the allowed-tools mechanism (see
 *     `kodax constructed disable-self-modify <name>` in P6) cleanly
 *     stops self-modify without affecting that agent's ability to
 *     create OTHER agents through `stage_agent_construction`.
 *
 * This module is the "stage" half of the FEATURE_090 lifecycle. The
 * `test_agent` and `activate_agent` tools from FEATURE_089 are reused
 * verbatim — admission-bridge + 5-step audit + sandbox cases work
 * identically whether the manifest came from stage_self_modify or
 * stage_agent_construction. The activate path layers on top FEATURE_090's
 * additional plumbing (LLM diff summary, force ask-user, deferred
 * registry swap) — see [packages/coding/src/construction/runtime.ts]
 * once P3 lands.
 */

import type { KodaXToolExecutionContext } from '../types.js';

import {
  type AgentArtifact,
  getRuntimeCwd,
  listArtifacts,
  stage as stageArtifact,
} from '../construction/index.js';
import {
  appendAuditEntry,
  computeDiffHash,
} from '../construction/audit-log.js';
import {
  readBudget,
  remaining as remainingBudget,
} from '../construction/budget.js';
import { readDisableState } from '../construction/disable-state.js';
import { validateSelfModify } from '../construction/self-modify.js';

/**
 * Single source of truth for the FEATURE_090 tool name. Used both by
 * the registry definitions and by any future per-agent gating
 * (`disable_self_modify`) that references the name as a string.
 */
export const SELF_MODIFY_TOOL_NAME = 'stage_self_modify' as const;

// ---------------------------------------------------------------------------
// Helpers (mirrors `agent-construction.ts` style — kept duplicated rather
// than shared to avoid creating an internal-helpers module that pulls
// FEATURE_089 and FEATURE_090 into a single inheritance hierarchy).
// ---------------------------------------------------------------------------

function readRequiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`'${key}' is required and must be a non-empty string.`);
  }
  return value.trim();
}

function parseArtifactJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`artifact_json failed to parse as JSON: ${(err as Error).message}`);
  }
}

function asAgentArtifact(value: unknown): AgentArtifact {
  if (!value || typeof value !== 'object') {
    throw new Error('artifact must be a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'agent') {
    throw new Error(`artifact.kind must be 'agent' (got ${JSON.stringify(obj.kind)}).`);
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    throw new Error('artifact.name must be a non-empty string.');
  }
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new Error('artifact.version must be a non-empty string (semver recommended).');
  }
  if (!obj.content || typeof obj.content !== 'object') {
    throw new Error('artifact.content must be an object.');
  }
  const content = obj.content as Record<string, unknown>;
  if (typeof content.instructions !== 'string' || content.instructions.trim().length === 0) {
    throw new Error('artifact.content.instructions must be a non-empty string.');
  }
  return value as AgentArtifact;
}

/**
 * Locate the currently-active manifest for an agent name. Returns
 * `undefined` when the agent has no active version (either never
 * activated or fully revoked). Each constructed agent is allowed at
 * most one active version at a time — the resolver guarantees this
 * — so the find returns at most one record.
 */
async function findActiveAgentArtifact(name: string): Promise<AgentArtifact | undefined> {
  const all = await listArtifacts('agent');
  return all.find(
    (a): a is AgentArtifact =>
      a.kind === 'agent' && a.name === name && a.status === 'active',
  );
}

// ---------------------------------------------------------------------------
// stage_self_modify
// ---------------------------------------------------------------------------

/**
 * Stage a self-modify proposal. The flow:
 *
 *   1. Parse the artifact JSON (same shape as stage_agent_construction).
 *   2. Defense-in-depth identity check: artifact.name must equal
 *      artifact.sourceAgent — the manifest is required to claim "I am
 *      modifying myself." `sourceAgent` mismatch hard-rejects without
 *      consulting the budget or the prior manifest.
 *   3. Locate the current active manifest at the same name. Self-modify
 *      requires there to be a "from" version; first-time staging must
 *      go through `stage_agent_construction`.
 *   4. Read the per-agent budget from the persisted counter.
 *   5. Run `validateSelfModify` (kind / name / budget / ratchet /
 *      reasoning-ceiling) on the prev/next pair. Any hard-reject
 *      writes a `self_modify_rejected` audit entry and returns.
 *   6. Persist via `stage()` (status='staged', testedAt cleared),
 *      then write a `self_modify_staged` audit entry.
 *
 * The budget counter is NOT decremented at stage time — only at
 * activate time, matching the design intent ("a self-modify that
 * fails admission or that the user rejects shouldn't burn a slot").
 * That decrement lives in P3 once `activate` learns the self-modify
 * branch.
 *
 * Diagnostic / fail-fast errors (parse failures, missing required
 * fields, etc.) bubble up as `[Tool Error] …` strings — same
 * convention every other coding tool follows.
 */
export async function toolStageSelfModify(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const raw = readRequiredString(input, 'artifact_json');
    const artifact = asAgentArtifact(parseArtifactJson(raw));

    // 2. sourceAgent identity check — defense in depth on top of the
    //    name-match check `validateSelfModify` will run again below.
    if (typeof artifact.sourceAgent !== 'string' || artifact.sourceAgent.length === 0) {
      return [
        `[Tool Error] ${SELF_MODIFY_TOOL_NAME}:`,
        `artifact.sourceAgent is required for self-modify and must equal artifact.name (the agent claiming the modification).`,
      ].join(' ');
    }
    if (artifact.sourceAgent !== artifact.name) {
      return [
        `[Tool Error] ${SELF_MODIFY_TOOL_NAME}:`,
        `artifact.sourceAgent='${artifact.sourceAgent}' does not match artifact.name='${artifact.name}'.`,
        `Self-modify only allows an agent to publish a new version of itself.`,
        `To create a different agent, use stage_agent_construction.`,
      ].join(' ');
    }

    // 3. Locate the active prior manifest.
    const prev = await findActiveAgentArtifact(artifact.name);
    if (!prev) {
      return [
        `[Tool Error] ${SELF_MODIFY_TOOL_NAME}:`,
        `no active version of '${artifact.name}' on disk.`,
        `Self-modify requires an existing active manifest — use stage_agent_construction for first-time staging.`,
      ].join(' ');
    }

    // 4. Budget + disable snapshot. Routed through the construction
    //    runtime's configured cwd so a non-default test/CLI workspace
    //    points at the same `.kodax/constructed/` tree the rest of the
    //    runtime reads from.
    const cwd = getRuntimeCwd();
    const [budgetState, disableState] = await Promise.all([
      readBudget(artifact.name, { cwd }),
      readDisableState(artifact.name, { cwd }),
    ]);
    const budgetRemaining = remainingBudget(budgetState);

    // 5. Hard checks.
    const validation = validateSelfModify({
      prev: prev.content,
      next: artifact.content,
      prevName: prev.name,
      nextName: artifact.name,
      prevKind: prev.kind,
      nextKind: artifact.kind,
      budgetRemaining,
      isDisabled: disableState.disabled,
    });

    if (!validation.ok) {
      // Audit the reject so an operator replaying the log sees every
      // attempt — including ones that never reached test/activate.
      await appendAuditEntry(
        {
          ts: new Date().toISOString(),
          event: 'self_modify_rejected',
          agentName: artifact.name,
          toVersion: artifact.version,
          fromVersion: prev.version,
          diffHash: computeDiffHash(prev.content, artifact.content),
          budgetRemaining,
          rejectRule: validation.rule,
          rejectReason: validation.reason,
        },
        { cwd },
      );
      return [
        `[Tool Error] ${SELF_MODIFY_TOOL_NAME}: rule='${validation.rule}'`,
        validation.reason,
      ].join(' — ');
    }

    // 6. Persist + audit.
    const handle = await stageArtifact(artifact);
    await appendAuditEntry(
      {
        ts: new Date().toISOString(),
        event: 'self_modify_staged',
        agentName: artifact.name,
        toVersion: artifact.version,
        fromVersion: prev.version,
        diffHash: computeDiffHash(prev.content, artifact.content),
        budgetRemaining,
      },
      { cwd },
    );

    return [
      `staged self-modify: ${handle.artifact.name} ${prev.version} → ${handle.artifact.version}`,
      `status=${handle.artifact.status} budgetRemaining=${budgetRemaining}/${budgetState.limit}`,
      'Next: call test_agent with name and version. Activation will require user approval (force-ask-user).',
    ].join('\n');
  } catch (err) {
    return `[Tool Error] ${SELF_MODIFY_TOOL_NAME}: ${(err as Error).message}`;
  }
}
