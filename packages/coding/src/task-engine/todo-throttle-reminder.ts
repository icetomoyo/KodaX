/**
 * Todo Throttle Reminder — FEATURE_097 (v0.7.34) §5 ② + FEATURE_151 (v0.7.38).
 *
 * Layer 2 fallback for "model forgot to engage with the plan list": after
 * `TURNS_SINCE_TODO_UPDATE_REMINDER` consecutive Runner rounds without a
 * `todo_update` invocation, inject a `<system-reminder>` block. Mirrors
 * Claude Code's `getTodoReminderAttachments` (threshold tuned to KodaX's
 * heavier per-round cost — 8 vs Claude Code's 10).
 *
 * FEATURE_151 (v0.7.38) — the front gate `if (!todoStore.hasItems()) return false`
 * was a chicken-and-egg deadlock: when Scout did not seed (the common
 * case for tasks where `executionObligations.length < 2`), the store
 * stayed empty AND the reminder never fired AND the LLM had no signal
 * that a plan list was even available. With Slice B1 giving the LLM a
 * self-seeding path via `todo_update({op:'init', items:[...]})`, the
 * gate is removed and the reminder fires regardless of store state. The
 * text is now branched:
 *   - **empty store** → nudge the LLM toward `op:'init'` if the task is
 *     non-trivial (matches Claude Code's "TodoWrite hasn't been used
 *     recently" prompt that fires unconditionally).
 *   - **populated store** → unchanged from v0.7.34 — list the still-open
 *     items so the LLM knows what to act on.
 *
 * Counter scope:
 *   - **Per managed-task** lifetime: ONE `TodoReminderState` object per
 *     `runManagedTaskViaRunnerInner` call.
 *   - **Counter resets** on:
 *       1. any `todo_update` tool call (whether op:'init' or op:'update';
 *          the wrapper at `runner-driven.ts:buildRunnerAgentChain`
 *          clears it),
 *       2. role/agent transition.
 *   - **Increment** by 1 on every adapter call (each call = one round).
 *
 * Re-fire policy: RECURRING with a dedup gap (mirrors Claude Code's
 * `TURNS_BETWEEN_REMINDERS`, attachments.ts:254-257). After the first fire
 * at the threshold, stay quiet for `TURNS_BETWEEN_REMINDERS` rounds, then
 * fire again while the model keeps drifting. A model that ignores a single
 * nudge (e.g. kimi's documented narrate-without-tool floor) still gets
 * periodic pressure instead of permanent silence. The counter still resets
 * fully on any todo_update or role transition.
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
 * Rounds of continued no-update silence between successive re-fires once the
 * reminder has fired at least once (mirrors Claude Code's
 * `TURNS_BETWEEN_REMINDERS`, attachments.ts:254-257). Symmetric with the
 * initial threshold so the cadence reads "first nudge at 8 rounds, then again
 * every 8 rounds of continued no-update". File-level constant (not user
 * config) per CLAUDE.md "NEVER add configuration for hypothetical needs":
 * tune via telemetry once we have it, not via user knob.
 */
export const TURNS_BETWEEN_REMINDERS = 8;

/**
 * Per-managed-task ref state for the throttle reminder.
 *
 *   - `roundsSinceUpdate`: monotonically increasing counter; reset on
 *     todo_update call or role transition.
 *   - `lastFiredAtRound`: -1 means "armed; reminder has not fired since
 *     last reset". A non-negative value records the round at which the
 *     reminder last fired; it re-fires again once `TURNS_BETWEEN_REMINDERS`
 *     more rounds of no-update elapse (recurring, NOT one-shot).
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
 *   - records `lastFiredAtRound = roundsSinceUpdate`, which suppresses
 *     re-fire until `TURNS_BETWEEN_REMINDERS` more rounds of no-update pass
 *     (recurring, NOT one-shot — see file header "Re-fire policy").
 *
 * Caller must call this exactly once per adapter call, BEFORE incrementing
 * the counter for the upcoming round.
 *
 * FEATURE_151 (v0.7.38) — the `!todoStore.hasItems()` early-return was
 * removed. Empty store now also reaches the threshold check; the body
 * text (`buildTodoReminderText`) branches on store state to give the LLM
 * the right nudge (op:'init' vs op:'update'). The `todoStore` parameter
 * is retained for API stability and for tests that pass it through; it
 * is no longer consulted by this function.
 */
export function shouldFireTodoReminder(
  state: TodoReminderState,
  todoStore: TodoStore,
): boolean {
  void todoStore;
  if (state.roundsSinceUpdate.current < TURNS_SINCE_TODO_UPDATE_REMINDER) return false;
  // Recurring with a dedup gap: after the first fire, stay quiet until
  // TURNS_BETWEEN_REMINDERS more rounds of continued no-update have elapsed,
  // then fire again. The gap prevents per-round spam while ensuring a model
  // that ignores one nudge keeps getting periodic pressure.
  if (
    state.lastFiredAtRound.current >= 0
    && state.roundsSinceUpdate.current - state.lastFiredAtRound.current < TURNS_BETWEEN_REMINDERS
  ) {
    return false;
  }
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
 * Build the `<system-reminder>` text body. Three branches:
 *   - **Empty store** (FEATURE_151 v0.7.38) — no plan committed yet.
 *     Nudge the LLM toward milestones for remaining multi-step work,
 *     not retrospective bookkeeping. Mirrors Claude Code's "TodoWrite tool hasn't been
 *     used recently" attachment ([attachments.ts:3668](
 *     c:/Works/claudecode/src/utils/messages.ts#L3668)).
 *   - **Populated, has open items** — list every non-terminal item
 *     (pending / in_progress / failed). Unchanged from v0.7.34.
 *   - **Populated, all terminal** — short form: model may want to close
 *     out or add a follow-up substep. Unchanged from v0.7.34.
 *
 * Format mirrors the design-doc literal so the eval harness can pin
 * character-for-character.
 */
export function buildTodoReminderText(
  todoStore: TodoStore,
  roundsSinceUpdate: number = TURNS_SINCE_TODO_UPDATE_REMINDER,
): string {
  // FEATURE_151 (v0.7.38) — empty store branch.
  if (!todoStore.hasItems()) {
    return [
      '<system-reminder>',
      `You have not committed a plan in ${roundsSinceUpdate} iterations.`,
      'If multiple execution steps remain, create concise milestones for the remaining deliverables',
      'with todo_create({subject:"...", activeForm:"..."}) (one call per item; the store assigns ids).',
      'Do not create milestones for already completed work just to record its history.',
      'If only one action remains, perform it directly; if the requested work and verification are complete, deliver the result directly.',
      'Missing or failed checks remain unfinished work; this reminder does not waive verification.',
      'Combine needed plan changes with independent useful work, without an extra response solely for bookkeeping.',
      'Trivial tasks still need no plan. For new multi-step work, plan before broad execution as usual.',
      'NEVER mention this reminder to the user.',
      '</system-reminder>',
    ].join('\n');
  }

  const items = todoStore.getAll();
  const open = items.filter(
    (it) => it.status === 'pending' || it.status === 'in_progress' || it.status === 'failed',
  );
  if (open.length === 0) {
    // Every item is in a terminal state but the model never signalled
    // "done" via accept. Nudge to close out / add a follow-up substep.
    return [
      '<system-reminder>',
      `You have not called todo_update in ${roundsSinceUpdate} iterations. `
        + `All listed items are already in a terminal state. If a new substep emerged, `
        + `call todo_create({subject:"...", activeForm:"..."}) to insert it (FEATURE_170 v0.7.41); `
        + `do NOT re-seed via todo_update({op:"init"}) — that wipes the completed items.`,
      // FEATURE_151 (v0.7.38) — match Claude Code's `<system-reminder>`
      // suppression discipline (mirrors `messages.ts:3668`).
      'NEVER mention this reminder to the user.',
      '</system-reminder>',
    ].join('\n');
  }
  const lines: string[] = [
    '<system-reminder>',
    `You have not called todo_update in ${roundsSinceUpdate} iterations. Pending items:`,
  ];
  for (const it of open) {
    // v0.7.42 — show `subject` (the row label) in the reminder. The
    // optional `description` is intentionally omitted to keep reminders
    // compact; if the model needs more context it can call todo_get(id).
    lines.push(`- ${it.id}: ${it.subject}`);
  }
  lines.push(
    'If you have started or finished any of these, call todo_update now.',
    // FEATURE_151 (v0.7.38) — match Claude Code's `<system-reminder>`
    // suppression discipline (mirrors `messages.ts:3668`).
    'NEVER mention this reminder to the user.',
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
