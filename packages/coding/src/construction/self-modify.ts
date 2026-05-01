/**
 * FEATURE_090 (v0.7.32) — Self-modify hard checks (pure functions).
 *
 * `validateSelfModify` runs the deterministic, mechanical-rule checks
 * that gate a self-modify proposal BEFORE it reaches the policy gate
 * (which solicits user approval). The split is deliberate:
 *
 *   - **Hard rejects** (this module): objective rule violations the
 *     user should NOT be asked about. Examples: removing a guardrail
 *     (ratchet violation), changing the agent's name, exhausted
 *     modification budget. These are mechanical "no" answers — every
 *     correct human reviewer would say no, so we save the round-trip.
 *
 *   - **Soft signals** (handled later by LLM diff summary +
 *     ask-user): "is this change too big / suspicious-looking?"
 *     These are subjective and flow through the user via a structured
 *     LLM summary. No arbitrary thresholds here.
 *
 * Why this lives outside the FEATURE_101 admission invariant set:
 *   The 7+1 invariants in `@kodax/core/admission` run on EVERY
 *   constructed agent (first-time stage_agent included). Ratchet
 *   semantics ("new ⊇ old") only make sense in the self-modify
 *   path — there is no "old" for a first-time stage. Embedding it in
 *   admission would force every invariant runner to special-case
 *   "if no prior, skip" and pollute the v1 closed-set guarantee
 *   ([docs/features/v0.7.31.md FEATURE_101]).
 *
 * Pure functions only: no I/O, no shared mutable state. Budget
 * counter persistence lives in `./budget.ts`; audit log writes live
 * in `./audit-log.ts`.
 */

import type { AgentContent, GuardrailRef } from './types.js';

/**
 * Outcome of a hard-check pass. A `reject` outcome carries the rule
 * id (machine-readable for callers that want to discriminate) and a
 * human-readable reason. `ok: true` carries no payload — soft-signal
 * data (LLM summary etc.) is computed by the caller, not here.
 */
export type SelfModifyValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly rule: SelfModifyRuleId;
      readonly reason: string;
    };

/**
 * Stable rule identifiers for the hard-reject set. Stable so audit
 * log entries and CLI error messages can pivot on them without
 * string-matching the human-readable reason.
 *
 * v1 closed set:
 *   - `name-changed`        — artifact.name diverged between prev/next
 *   - `kind-invalid`        — either prev or next kind is not 'agent';
 *                             only 'agent' artifacts can self-modify
 *                             (covers both "kind changed mid-flight"
 *                             and "kind was never agent to begin with")
 *   - `guardrail-ratchet`   — new manifest's guardrail set is not a
 *                             superset of the prior set
 *   - `reasoning-ceiling`   — proposed reasoning.max exceeds the
 *                             configured user ceiling
 *   - `budget-exhausted`    — caller has already consumed the
 *                             modification budget for this agent
 *   - `self-modify-disabled` — operator has explicitly disabled this
 *                              agent's self-modify capability via the
 *                              `kodax constructed disable-self-modify`
 *                              CLI. Permanent (no re-enable command;
 *                              by design — see FEATURE_090 spec).
 */
export type SelfModifyRuleId =
  | 'name-changed'
  | 'kind-invalid'
  | 'guardrail-ratchet'
  | 'reasoning-ceiling'
  | 'budget-exhausted'
  | 'self-modify-disabled';

/**
 * Reasoning depth ordering used by the ceiling check. Mirrors the
 * `'quick' < 'balanced' < 'deep'` ordering implied by
 * `AgentReasoningRef`. Centralizing the rank here lets the ceiling
 * comparison stay a one-liner without scattering ad-hoc maps.
 */
const REASONING_RANK = { quick: 0, balanced: 1, deep: 2 } as const;
type ReasoningLevel = keyof typeof REASONING_RANK;

export interface ValidateSelfModifyInput {
  /** Prior `AgentContent` from the currently-active manifest. */
  readonly prev: AgentContent;
  /** Proposed `AgentContent` the agent is trying to publish. */
  readonly next: AgentContent;
  /**
   * Identity claim from the artifact envelope. Both must match the
   * caller's own identity — checked separately by stage_self_modify
   * before we get here, but re-asserted as defense in depth.
   */
  readonly prevName: string;
  readonly nextName: string;
  readonly prevKind: 'tool' | 'agent';
  readonly nextKind: 'tool' | 'agent';
  /**
   * System-configured ceiling on reasoning depth. The agent's new
   * `reasoning.max` may not exceed this. Defaults to `'deep'` (no
   * ceiling effectively) when undefined — matches the existing
   * AgentReasoningRef contract.
   */
  readonly userReasoningCeiling?: ReasoningLevel;
  /**
   * Snapshot of the agent's modification budget at validate time.
   * `remaining === 0` short-circuits to a hard reject so the caller
   * doesn't burn an LLM call on a manifest that can never activate.
   */
  readonly budgetRemaining: number;
  /**
   * `true` when the operator has explicitly disabled this agent's
   * self-modify capability via the CLI (P6). The IO that determines
   * this lives in the caller (CLI / stage_self_modify tool); kept
   * outside `validateSelfModify` so the function stays pure.
   * Defaults to `false` when omitted.
   */
  readonly isDisabled?: boolean;
}

/**
 * Run all hard checks in fail-fast order:
 *
 *   1. kind / name identity (defense in depth — duplicates the
 *      stage_self_modify entry guard, but cheap and order-independent)
 *   2. budget exhaustion (cheap, avoids LLM cost on a doomed manifest)
 *   3. guardrail ratchet (set comparison; the load-bearing security check)
 *   4. reasoning ceiling (final, depends only on next manifest)
 *
 * Returns the FIRST failure encountered — callers don't need a list
 * of all violations because the LLM that submitted the manifest
 * should fix one and resubmit. Cumulative reporting is for sanity
 * checking by humans, not LLM authoring.
 */
export function validateSelfModify(
  input: ValidateSelfModifyInput,
): SelfModifyValidation {
  if (input.prevKind !== 'agent' || input.nextKind !== 'agent') {
    return {
      ok: false,
      rule: 'kind-invalid',
      reason: `Self-modify only supports kind='agent' (prev='${input.prevKind}', next='${input.nextKind}'). Tool artifacts cannot self-modify; bump version via stage_tool instead.`,
    };
  }
  if (input.prevName !== input.nextName) {
    return {
      ok: false,
      rule: 'name-changed',
      reason: `Self-modify must keep the same name (prev='${input.prevName}', next='${input.nextName}'). Use stage_agent to publish a differently-named agent.`,
    };
  }
  if (input.isDisabled) {
    return {
      ok: false,
      rule: 'self-modify-disabled',
      reason: `Self-modify has been permanently disabled for agent '${input.prevName}' via 'kodax constructed disable-self-modify'. To author a different agent with similar capabilities, stage a separately-named manifest via stage_agent_construction.`,
    };
  }
  if (input.budgetRemaining <= 0) {
    return {
      ok: false,
      rule: 'budget-exhausted',
      reason: `Modification budget for '${input.prevName}' is exhausted. Run 'kodax constructed reset-self-modify-budget ${input.prevName}' to unlock further self-modifications.`,
    };
  }

  const ratchetResult = checkGuardrailRatchet(input.prev.guardrails, input.next.guardrails);
  if (!ratchetResult.ok) {
    return ratchetResult;
  }

  const ceilingResult = checkReasoningCeiling(input.next, input.userReasoningCeiling);
  if (!ceilingResult.ok) {
    return ceilingResult;
  }

  return { ok: true };
}

/**
 * Guardrail ratchet check — the load-bearing safety rule. The new
 * guardrail set must contain every member of the prior set; adding
 * is allowed, removing is not.
 *
 * Identity is by `(kind, ref)` pair. Two guardrails with the same
 * `ref` but different `kind` (e.g. one input, one output) are treated
 * as distinct — removing the input variant is still a removal even if
 * the output variant remains.
 *
 * Why this matters: without the ratchet, a self-modifying agent's
 * very first action could be to publish a new manifest that drops
 * every guardrail it inherited. The Layer A admission audit doesn't
 * notice removals because admission only checks "are the listed
 * guardrails legitimate," not "did you have more before."
 */
function checkGuardrailRatchet(
  prev: readonly GuardrailRef[] | undefined,
  next: readonly GuardrailRef[] | undefined,
): SelfModifyValidation {
  if (!prev || prev.length === 0) {
    // No prior guardrails — nothing to ratchet against.
    return { ok: true };
  }
  const nextKey = new Set(
    (next ?? []).map((g) => guardrailKey(g)),
  );
  const removed: string[] = [];
  for (const g of prev) {
    if (!nextKey.has(guardrailKey(g))) {
      removed.push(guardrailKey(g));
    }
  }
  if (removed.length > 0) {
    return {
      ok: false,
      rule: 'guardrail-ratchet',
      reason:
        `Guardrail ratchet violated — self-modify cannot remove existing guardrails. ` +
        `Missing in proposed manifest: ${removed.join(', ')}. ` +
        `Add the missing guardrail(s) back, or stage a separately-named agent if a different safety posture is required.`,
    };
  }
  return { ok: true };
}

function guardrailKey(g: GuardrailRef): string {
  return `${g.kind}:${g.ref}`;
}

/**
 * Verify that `next.reasoning.max` does not exceed the system ceiling.
 *
 * Both fields are optional — when either is undefined we treat the
 * check as a no-op. The KodaX Agent contract treats missing
 * `reasoning.max` as "no agent-side opt-in to escalation" so an
 * undefined `next.reasoning.max` cannot violate any ceiling.
 */
function checkReasoningCeiling(
  next: AgentContent,
  ceiling: ReasoningLevel | undefined,
): SelfModifyValidation {
  if (ceiling === undefined) return { ok: true };
  const proposed = next.reasoning?.max;
  if (proposed === undefined) return { ok: true };
  if (REASONING_RANK[proposed] > REASONING_RANK[ceiling]) {
    return {
      ok: false,
      rule: 'reasoning-ceiling',
      reason:
        `Proposed reasoning.max='${proposed}' exceeds the configured user ceiling '${ceiling}'. ` +
        `Lower the requested max or have the user raise the ceiling.`,
    };
  }
  return { ok: true };
}
