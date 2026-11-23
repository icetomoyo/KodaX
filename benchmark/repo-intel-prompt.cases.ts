/**
 * Cases for the repo-intelligence prompt eval (benchmark/repo-intel-prompt.eval.ts).
 * Every input is a real first request from the managed Runtime: C1, C2 and C4 come from
 * tests/managed-first-turn.capture.ts on its dirty cache workspace; C3 from the same capture path run by
 * the eval on a copy of packages/llm. Only the changed prompt text differs between the two arms.
 * Questions and the review rubric are pre-registered here, before any provider call.
 * The managed menu sends deferred tools with their short hints (tools/deferred-tools.ts), so the edited
 * changed_scope / semantic_lookup descriptions reach a model only through tool_search; these first
 * requests carry them in neither arm. repo-explorer and the low-confidence note are not rendered either.
 */

/** One zero-network Runtime capture: repository-intelligence mode, optional child lane, and the root tasks. */
export interface CaptureSpec {
  readonly id: 'auto-root' | 'llm-full-root' | 'auto-child';
  readonly repoMode: 'auto' | 'full';
  /** cache: the capture script's 14-file fixture. llm: packages/llm at the baseline ref, about 250 files. */
  readonly workspace: 'cache' | 'llm';
  readonly childLane?: 'read';
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly task: string }>;
}

export const CAPTURES: readonly CaptureSpec[] = [
  { id: 'auto-root', repoMode: 'auto', workspace: 'cache', tasks: [
    { id: 'review', task: 'Please review my uncommitted changes for bugs before I commit them.' },
  ] },
  // Revision r2: r1 asked a concept question on the cache fixture, whose run context lists every file, so both
  // pilot arms read the obvious file and no response could show how semantic_lookup gets queried.
  { id: 'llm-full-root', repoMode: 'full', workspace: 'llm', tasks: [
    { id: 'retry', task: 'Where in this codebase do we retry a provider request after a network failure? Point me to the code.' },
  ] },
  { id: 'auto-child', repoMode: 'auto', workspace: 'cache', childLane: 'read', tasks: [
    { id: 'childmap', task: 'Map how the identity package\'s exports are consumed across this repository.' },
  ] },
];

/** The objective the capture script gives its child; C4 swaps in its own objective in both arms alike. */
export const CAPTURE_CHILD_OBJECTIVE = 'Fix the TTL boundary in packages/cache-client so an entry expires exactly at its TTL, and report the change.';
export const C4_CHILD_OBJECTIVE = 'Map how the exports of packages/identity are consumed across this repository: which files import them, under which names, and through which re-exports. Report file:line evidence.';

export interface RepoIntelCase {
  readonly id: 'C1' | 'C2' | 'C3' | 'C4';
  readonly capture: CaptureSpec['id'];
  readonly task: string;
  readonly use: 'root' | 'child';
  /** strip-change-scope: drop the injected Repository Change Scope; child-objective: swap the child objective. */
  readonly transform?: 'strip-change-scope' | 'child-objective';
  /** Changed texts that must reach this case's request; prepare fails when one is missing. */
  readonly requiredSwaps: readonly string[];
  /** A sentence only the candidate arm carries, and one only the baseline arm carries. */
  readonly candidateSentence: string;
  readonly baselineSentence: string;
  readonly question: string;
  readonly rubric: string;
}

export const CASES: readonly RepoIntelCase[] = [
  {
    id: 'C1', capture: 'auto-root', task: 'review', use: 'root',
    requiredSwaps: ['worker.repo-tools.changed-scope'],
    candidateSentence: 'reuse it instead of calling `changed_scope` again',
    baselineSentence: 'before reading any diff.\n- For change-set review, establish the requested scope',
    question: 'Default Worker, review request, run context already holds a Repository Change Scope for the worktree. Does the next response reuse the injected scope (changed_diff, read, or review lanes built from it) instead of calling changed_scope again?',
    rubric: 'Better: acts on the injected file list (diffs, reads, or lanes split by its areas) without a redundant changed_scope call, and still covers the whole change set. Not worse: a changed_scope call with a stated reason the injected scope does not fit. Harm: skipping scope in a way that loses files from the review.',
  },
  {
    id: 'C2', capture: 'auto-root', task: 'review', use: 'root', transform: 'strip-change-scope',
    requiredSwaps: ['worker.repo-tools.changed-scope'],
    candidateSentence: 'reuse it instead of calling `changed_scope` again',
    baselineSentence: 'before reading any diff.\n- For change-set review, establish the requested scope',
    question: 'Guard. Same review request, but the run context has no Repository Change Scope. Does the candidate still acquire scope with changed_scope before reading diffs?',
    rubric: 'Expected on both arms: changed_scope first (or a lane plan that starts from changed_scope). Harm: the candidate skips scope acquisition and reads diffs or files from the git status list alone.',
  },
  {
    id: 'C3', capture: 'llm-full-root', task: 'retry', use: 'root',
    requiredSwaps: ['worker-role-prompt.ts:semantic_lookup', 'worker-role-prompt.ts:symbol_context', 'worker.repo-tools.changed-scope'],
    candidateSentence: 'query it with likely identifiers rather than descriptions of behavior',
    baselineSentence: 'Use `semantic_lookup` for concepts rather than exact strings.',
    question: 'Opted-in surface (repoIntelligenceMode full, semantic tools present). The user asks a behavioral question. Does the model avoid a descriptive-sentence semantic_lookup query, preferring grep/read or an identifier-like query?',
    rubric: 'Better: grep/glob or identifier-like semantic_lookup queries (retry, backoff, network error names) that can match indexed names. Worse: semantic_lookup with a behavior description (e.g. "retry provider request after network failure"), which substring name matching cannot answer. Neutral: other structured tools or direct reads aimed at likely files.',
  },
  {
    id: 'C4', capture: 'auto-child', task: 'childmap', use: 'child', transform: 'child-objective',
    requiredSwaps: ['child.system.intro'],
    candidateSentence: 'For module exploration, single-file lookup, or byte-exact verification, use `glob` + `grep` + targeted `read`.',
    baselineSentence: 'such as `module_context` or `changed_scope`',
    question: 'Read-only child sub-agent on the default surface (no module_context in its tools), asked to map how a module\'s exports are consumed. Does its first response use tools it actually has (glob/grep/read/LSP) rather than naming or attempting module_context?',
    rubric: 'Better: a parallel glob/grep/read (or LSP) opening aimed at the exports and their importers. Worse: calling or planning around module_context or another absent tool, or a changed_scope call that has nothing to do with the objective.',
  },
];
