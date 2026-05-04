/**
 * Todo Throttle Reminder — FEATURE_097 (v0.7.34) §5 ②.
 *
 * Layer 2 fallback for "model forgot to call `todo_update`": after
 * `TURNS_SINCE_TODO_UPDATE_REMINDER` consecutive Runner rounds without a
 * `todo_update` invocation, inject a `<system-reminder>` block listing the
 * still-pending items as a nudge. Mirrors Claude Code's
 * `getTodoReminderAttachments`, with the threshold tuned for KodaX's
 * heavier per-round cost (one round = LLM turn + tool calls; KodaX rounds
 * are noticeably heavier than Claude Code's, hence 8 vs Claude Code's 10).
 *
 * Counter scope (per design — note that the source design doc has two
 * bullets that read self-contradictory; this docstring resolves them):
 *   - **Per managed-task** in the lifetime sense: ONE `TodoReminderState`
 *     object is created per `runManagedTaskViaRunnerInner` call and lives
 *     for the whole task. State is NOT created fresh for each Scout /
 *     Planner / Generator / Evaluator role. (This is what the design's
 *     "per managed-task (NOT per agent)" bullet was protecting against —
 *     the *object's lifetime*, not the counter's value.)
 *   - **Counter resets** on:
 *       1. any `todo_update` tool call (the wrapper at
 *          `runner-driven.ts:buildRunnerAgentChain` clears it),
 *       2. role/agent transition (the LLM adapter clears it when it sees
 *          a different `agent.name` on a successive call). The design's
 *          "phase 切换 (Scout → Planner → Generator → Evaluator) → 0"
 *          bullet drives this; it gives every role a fresh 8-round window
 *          rather than letting Scout's quiet investigation eat into
 *          Generator's first turn.
 *   - **Increment** by 1 on every adapter call (each call = one round).
 *
 * Front gate: when the store has no items (Scout obligations < 2 → store
 * never seeded), no reminder fires — keeps simple H0 tasks noise-free.
 *
 * Re-fire policy: fire ONCE per "run-of-no-updates". Once the reminder
 * has fired at counter ≥ threshold, it stays silent until the counter is
 * reset (either via `todo_update` call or role transition). This avoids
 * wedging the adapter into a permanent "every round inject" loop when
 * the model genuinely cannot make progress on the listed items.
 *
 * FEATURE_104: this module produces LLM-facing prompt text and therefore
 * must have a paired eval at `tests/feature-097-throttle-reminder.eval.ts`.
 */

import type { TodoStore } from './todo-store.js';

/**
 * Threshold in Runner rounds. KodaX file-level constant (not exposed via
 * config) per CLAUDE.md "NEVER add configuration for hypothetical needs":
 * tune via telemetry once we have it, not via user knob.
 */
export const TURNS_SINCE_TODO_UPDATE_REMINDER = 8;

/**
 * Per-managed-task ref state for the throttle reminder.
 *
 *   - `roundsSinceUpdate`: monotonically increasing counter; reset on
 *     todo_update call or role transition.
 *   - `lastFiredAtRound`: -1 means "armed; reminder has not fired since
 *     last reset". A non-negative value means the reminder has fired
 *     and is suppressed until the counter is reset.
 *   - `lastSeenAgentName`: the previous adapter call's `agent.name`;
 *     used to detect agent transitions so the counter can reset.
 */
export interface TodoReminderState {
  readonly roundsSinceUpdate: { current: number };
  readonly lastFiredAtRound: { current: number };
  readonly lastSeenAgentName: { current: string | undefined };
}

export function createTodoReminderState(): TodoReminderState {
  return {
    roundsSinceUpdate: { current: 0 },
    lastFiredAtRound: { current: -1 },
    lastSeenAgentName: { current: undefined },
  };
}

/** Reset on todo_update call OR role transition. Both clear the throttle. */
export function resetTodoReminderState(state: TodoReminderState): void {
  state.roundsSinceUpdate.current = 0;
  state.lastFiredAtRound.current = -1;
}

/**
 * Decide whether the reminder should fire for the upcoming adapter call.
 * Side effects when returning `true`:
 *   - flips `lastFiredAtRound` to `roundsSinceUpdate` (suppresses re-fire
 *     until the next reset).
 *
 * Caller must call this exactly once per adapter call, BEFORE incrementing
 * the counter for the upcoming round.
 */
export function shouldFireTodoReminder(
  state: TodoReminderState,
  todoStore: TodoStore,
): boolean {
  if (!todoStore.hasItems()) return false;
  if (state.roundsSinceUpdate.current < TURNS_SINCE_TODO_UPDATE_REMINDER) return false;
  if (state.lastFiredAtRound.current >= 0) return false; // already fired this run
  state.lastFiredAtRound.current = state.roundsSinceUpdate.current;
  return true;
}

/**
 * Increment the counter for the round that is about to start. Call this
 * AFTER `shouldFireTodoReminder` so the reminder check sees the current
 * (pre-increment) round value.
 */
export function tickTodoReminder(state: TodoReminderState): void {
  state.roundsSinceUpdate.current += 1;
}

/**
 * Build the `<system-reminder>` text body. Lists every non-terminal item
 * (pending OR in_progress OR failed) so the model sees what is still
 * outstanding. Skipped/completed items are NOT listed — the model only
 * needs to act on the ones that are still open.
 *
 * Format mirrors the design-doc literal exactly so the eval harness can
 * test for it character-for-character. The only variable parts are
 * `TURNS_SINCE_TODO_UPDATE_REMINDER` and the bullet list.
 */
export function buildTodoReminderText(todoStore: TodoStore): string {
  const items = todoStore.getAll();
  const open = items.filter(
    (it) => it.status === 'pending' || it.status === 'in_progress' || it.status === 'failed',
  );
  if (open.length === 0) {
    // Edge case: every item is in a terminal state but the model never
    // signalled "done" via accept. The reminder still has value as a
    // nudge to call `todo_update` to close out — but with no list to
    // print, fall back to a shorter form so we don't emit a malformed
    // empty bullet list.
    return [
      '<system-reminder>',
      `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations. ` +
        `All listed items are already in a terminal state, but you may want to call todo_update ` +
        `if any new substep emerged.`,
      '</system-reminder>',
    ].join('\n');
  }
  const lines: string[] = [
    '<system-reminder>',
    `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations. Pending items:`,
  ];
  for (const it of open) {
    lines.push(`- ${it.id}: ${it.content}`);
  }
  lines.push(
    'If you have started or finished any of these, call todo_update now.',
    '</system-reminder>',
  );
  return lines.join('\n');
}

/**
 * Detect agent transition. Updates `lastSeenAgentName` and returns
 * `true` when the agent name changed (i.e., a phase transition happened
 * between this adapter call and the previous one).
 *
 * On the very first adapter call (no previous name), returns `false` —
 * the initial entry into Scout is not a "transition" worth resetting on.
 */
export function detectAgentTransition(
  state: TodoReminderState,
  agentName: string,
): boolean {
  const prev = state.lastSeenAgentName.current;
  state.lastSeenAgentName.current = agentName;
  if (prev === undefined) return false;
  return prev !== agentName;
}
