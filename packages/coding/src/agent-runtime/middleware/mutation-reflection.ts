/**
 * Mutation scope reflection middleware — CAP-016
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-016-mutation-scope-reflection
 *
 * Class 3 (declarable opt-in middleware). When `mutationTracker` is wired
 * into the tool execution context AND the active Agent declaration enables
 * `middleware.mutationScopeReflection`, this appends a one-line scope
 * reflection to the tool result so the model perceives the size of the
 * change it just made:
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
 * **Default for**: `defaultCodingAgent` (preserves SA current behavior).
 * **NOT for** AMA agents — Generator's mutation tracking is handled by the
 * Evaluator's verdict pass instead, so reflection here would double-fire.
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

export function buildMutationScopeReflection(tracker: MutationTracker): string {
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
  const fileList = [...tracker.files.entries()]
    .map(([file, lines]) => `  - ${file} (~${lines} lines)`)
    .join('\n');
  return [
    '',
    `[Scope: ${tracker.files.size} files modified, ~${totalLines} lines]`,
    fileList,
    'A senior engineer would ask: does this change need review before shipping?',
    '→ Need review: call emit_managed_protocol({role:"scout", payload:{confirmed_harness:"H1_EXECUTE_EVAL", summary:"...", blocking_evidence:["..."]}})',
    '→ Need planning: call emit_managed_protocol with H2_PLAN_EXECUTE_EVAL',
    '→ Confident this is fine: continue working.',
  ].join('\n');
}
