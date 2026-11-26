/**
 * Runner-side structural nudges — FEATURE_114 v0.7.36.
 *
 * Plan-first nudge: after each Worker tool call, if the Worker has
 * read N files (read/grep/glob) without committing a plan via
 * `todo_update`, append a one-shot reminder to the next tool result.
 *
 * Soft-attached to tool results, NOT a runner-enforced plan-first
 * gate — Phase 0 industry survey showed 4/4 codebases use prompt
 * + structural nudge, never hard gating. Hard gating breaks Trivial
 * tasks ("just answer this single question") and forces every
 * conversation to go through a TodoWrite ceremony.
 *
 * The nudge fires AT MOST ONCE per session — once the Worker either
 * commits a plan or explicitly declines (via continued non-plan
 * tools past the threshold), the reminder stops.
 */

const DEFAULT_READ_THRESHOLD = 5;

export interface RunnerNudgeState {
  readonly readsSinceLastTodoUpdate: number;
  readonly anyTodoUpdateFired: boolean;
  readonly nudgeAlreadyEmitted: boolean;
}

export function createRunnerNudgeState(): RunnerNudgeState {
  return {
    readsSinceLastTodoUpdate: 0,
    anyTodoUpdateFired: false,
    nudgeAlreadyEmitted: false,
  };
}

export interface ObserveToolCallInput {
  readonly state: RunnerNudgeState;
  readonly toolName: string;
}

const READ_TOOL_NAMES = new Set<string>([
  'read',
  'grep',
  'glob',
  'code_search',
  'semantic_lookup',
  'find_symbol',
  'file_outline',
]);

/**
 * Update the nudge state after a tool call. Returns the new state —
 * caller writes it back to its mutable holder (e.g. a `{ current }`
 * ref). Pure function; does NOT side-effect.
 */
export function observeToolCall(input: ObserveToolCallInput): RunnerNudgeState {
  const { state, toolName } = input;
  if (toolName === 'todo_update') {
    return {
      readsSinceLastTodoUpdate: 0,
      anyTodoUpdateFired: true,
      nudgeAlreadyEmitted: state.nudgeAlreadyEmitted,
    };
  }
  if (READ_TOOL_NAMES.has(toolName)) {
    return {
      ...state,
      readsSinceLastTodoUpdate: state.readsSinceLastTodoUpdate + 1,
    };
  }
  return state;
}

export interface MaybeAppendPlanNudgeInput {
  readonly state: RunnerNudgeState;
  /** Override the "5 reads without plan" threshold. Default 5. */
  readonly readThreshold?: number;
}

export interface MaybeAppendPlanNudgeResult {
  readonly nudge: string | undefined;
  readonly nextState: RunnerNudgeState;
}

const NUDGE_TEXT =
  '[nudge] You have read several files without committing a plan. '
  + 'If this task is non-trivial (≥2 distinct steps OR touching ≥2 files/areas), '
  + 'call `todo_update` now to commit your plan. '
  + 'Trivial tasks (single typo / single-line edit / single-question lookup) '
  + 'skip this and answer / execute directly.';

/**
 * Decide whether to emit the plan-first nudge. Returns the nudge text
 * (to append to the next tool result) and the updated state.
 *
 * The nudge fires AT MOST ONCE per session — once emitted we set
 * `nudgeAlreadyEmitted`, so repeated reads past the threshold do NOT
 * spam the transcript. The Worker either:
 *   - calls `todo_update`, resetting `readsSinceLastTodoUpdate` to 0
 *     and signaling it understood;
 *   - keeps reading (Trivial-by-judgment), in which case one reminder
 *     was enough;
 *   - explicitly declines (continues into a write/edit), at which
 *     point the `plan-before-mutate` invariant takes over.
 */
export function maybeAppendPlanNudge(
  input: MaybeAppendPlanNudgeInput,
): MaybeAppendPlanNudgeResult {
  const threshold = input.readThreshold ?? DEFAULT_READ_THRESHOLD;
  const { state } = input;
  if (state.nudgeAlreadyEmitted) {
    return { nudge: undefined, nextState: state };
  }
  if (state.anyTodoUpdateFired) {
    return { nudge: undefined, nextState: state };
  }
  if (state.readsSinceLastTodoUpdate < threshold) {
    return { nudge: undefined, nextState: state };
  }
  return {
    nudge: NUDGE_TEXT,
    nextState: { ...state, nudgeAlreadyEmitted: true },
  };
}
