/**
 * Mutation scope reflection middleware — CAP-016 (SA-only).
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-016-mutation-scope-reflection
 *
 * Class 3 (declarable opt-in middleware). When `mutationTracker` is wired
 * into the tool execution context AND the active Agent declaration enables
 * `middleware.mutationScopeReflection`, this appends a self-review prompt
 * to the tool result so the model perceives the size of the change it
 * just made:
 *
 *   `[Scope: 5 files modified, ~412 lines]` followed by per-file lines
 *   and a senior-engineer rhetorical prompt.
 *
 * "Significant" is defined as ≥ `SCOPE_REFLECTION_FILE_THRESHOLD` files
 * OR ≥ `SCOPE_REFLECTION_LINES_THRESHOLD` total lines. The thresholds are
 * encoded as constants here (not Agent-declaration knobs) because they
 * came from product judgement, not configuration. Only the on/off
 * decision is declaration-controlled.
 *
 * **Default for**: `defaultCodingAgent` (SA mode only).
 * **NOT for** AMA agents — Generator's mutation tracking is handled by the
 * Evaluator's verdict pass instead, so reflection here would double-fire.
 * AMA's equivalent (FEATURE_106) lives in `scope-aware-harness-guardrail.ts`
 * and emits the harness-commitment hint via `emit_scout_verdict`.
 *
 * v0.7.31.2 — text rewrite: removed the dead AMA-escalation hint
 * (`emit_managed_protocol` references for H1/H2 confirmation) per
 * ADR-003 / FEATURE_106. SA mode is direct execution — there is no
 * mid-run harness escalation path, so prompting the LLM toward an
 * unavailable tool produced hallucinated tool calls. The replacement
 * text is SA-self-review oriented: SA has no Evaluator role, so the
 * reflection asks the model to verify its own change.
 *
 * Migration history: extracted from `agent.ts:781-809` — the `MUTATION_TOOL_NAMES`
 * + `SCOPE_REFLECTION_*` constants, the `isMutationTool` /
 * `isMutationScopeSignificant` predicates, and `buildMutationScopeReflection`
 * — pre-FEATURE_100 baseline — during FEATURE_100 P2.
 */

import type { KodaXToolExecutionContext } from '../../types.js';

const MUTATION_TOOL_NAMES = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'delete',
  'remove',
  'rename',
]);

const SCOPE_REFLECTION_FILE_THRESHOLD = 3;
const SCOPE_REFLECTION_LINES_THRESHOLD = 100;

type MutationTracker = NonNullable<KodaXToolExecutionContext['mutationTracker']>;

export function isMutationTool(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(name.toLowerCase());
}

export function isMutationScopeSignificant(tracker: MutationTracker): boolean {
  if (tracker.files.size >= SCOPE_REFLECTION_FILE_THRESHOLD) {
    return true;
  }
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
  return totalLines >= SCOPE_REFLECTION_LINES_THRESHOLD;
}

/**
 * Render the file-list / line-count header. Shared by the legacy CAP-016
 * builder and FEATURE_106's `scope-aware-harness-guardrail`. Exporting
 * the header separately removes the need for downstream callers to
 * string-parse the legacy builder's output to find a cutoff point.
 */
export function buildMutationScopeReflectionHeader(tracker: MutationTracker): string {
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
  const fileList = [...tracker.files.entries()]
    .map(([file, lines]) => `  - ${file} (~${lines} lines)`)
    .join('\n');
  return [
    '',
    `[Scope: ${tracker.files.size} files modified, ~${totalLines} lines]`,
    fileList,
  ].join('\n');
}

export function buildMutationScopeReflection(tracker: MutationTracker): string {
  return [
    buildMutationScopeReflectionHeader(tracker),
    'A senior engineer would pause here. SA mode has no Evaluator — you own the review:',
    '→ Re-read the diff: did each edit land on the intended file/region, and does the change as a whole match the user\'s intent?',
    '→ Run the project\'s typecheck/tests if available — uncaught regressions are your responsibility in SA mode.',
    '→ If this turned into a multi-stage task (plan → generate → verify), tell the user it would benefit from a re-run under AMA mode for an independent Evaluator pass.',
  ].join('\n');
}
