import { staticText } from '../../prompts/static-text.js';
/**
 * Mutation scope reflection middleware — CAP-016.
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-016-mutation-scope-reflection
 *
 * When the tool execution context carries a `mutationTracker` and the caller
 * does not pass `mutationScopeReflection: false` to `applyPostToolProcessing`,
 * this appends a self-review prompt to the first significant mutation result
 * so the model perceives the size of the change it just made:
 *
 *   `[Scope: 5 files modified, ~412 lines]` followed by per-file lines
 *   and a senior-engineer rhetorical prompt.
 *
 * "Significant" is defined as ≥ `SCOPE_REFLECTION_FILE_THRESHOLD` files
 * OR ≥ `SCOPE_REFLECTION_LINES_THRESHOLD` total lines. The thresholds are
 * constants because they came from product judgement, not configuration.
 *
 * Reached by the direct engine and host Script invocations when the caller
 * supplies a tracker. The AMA Worker's Script cells pass `false`: the parent
 * owns review policy there.
 *
 * The text never names escalation tools (`emit_managed_protocol`, harness
 * ids) or another mode: the legacy wording produced hallucinated tool calls,
 * and no re-run adds an independent reviewer.
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
    staticText("mutation-reflection.pause"),
  ].join('\n');
}
