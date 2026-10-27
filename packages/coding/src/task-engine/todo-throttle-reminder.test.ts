/**
 * Hermetic tests for the Layer 2 throttle reminder (FEATURE_097, v0.7.34).
 * No LLM calls. Covers:
 *   - state lifecycle (reset on todo_update, reset on role transition)
 *   - threshold + re-fire suppression
 *   - text formatting (matches design-doc literal)
 *   - empty-store + all-terminal edge cases
 */
import { describe, expect, it } from 'vitest';

import { createTodoStore } from './todo-store.js';
import {
  TURNS_SINCE_TODO_UPDATE_REMINDER,
  TURNS_BETWEEN_REMINDERS,
  buildTodoReminderText,
  createTodoReminderState,
  detectAgentTransition,
  resetTodoReminderState,
  shouldFireTodoReminder,
  tickTodoReminder,
} from './todo-throttle-reminder.js';

function makeSeededStore(): ReturnType<typeof createTodoStore> {
  const store = createTodoStore();
  store.init([
    { id: 'todo_1', subject: 'Locate test fixtures' },
    { id: 'todo_2', subject: 'Run migration tests' },
    { id: 'todo_3', subject: 'Update type definitions' },
  ]);
  return store;
}

describe('throttle reminder counter lifecycle', () => {
  it('starts at 0', () => {
    const state = createTodoReminderState();
    expect(state.roundsSinceUpdate.current).toBe(0);
    expect(state.lastFiredAtRound.current).toBe(-1);
  });

  it('tick increments by 1', () => {
    const state = createTodoReminderState();
    tickTodoReminder(state);
    tickTodoReminder(state);
    tickTodoReminder(state);
    expect(state.roundsSinceUpdate.current).toBe(3);
  });

  it('reset clears counter and re-arms the firing flag', () => {
    const state = createTodoReminderState();
    state.roundsSinceUpdate.current = 12;
    state.lastFiredAtRound.current = 8;
    resetTodoReminderState(state);
    expect(state.roundsSinceUpdate.current).toBe(0);
    expect(state.lastFiredAtRound.current).toBe(-1);
  });
});

describe('throttle reminder threshold (TURNS_SINCE_TODO_UPDATE_REMINDER = 8)', () => {
  it('does not fire below threshold', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER - 1;
    expect(shouldFireTodoReminder(state, store)).toBe(false);
  });

  it('fires exactly at threshold', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
    expect(state.lastFiredAtRound.current).toBe(TURNS_SINCE_TODO_UPDATE_REMINDER);
  });

  it('does not re-fire within the dedup gap after the first fire', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
    // Still inside the TURNS_BETWEEN_REMINDERS window → suppressed.
    state.roundsSinceUpdate.current =
      TURNS_SINCE_TODO_UPDATE_REMINDER + TURNS_BETWEEN_REMINDERS - 1;
    expect(shouldFireTodoReminder(state, store)).toBe(false);
  });

  it('RE-FIRES after the dedup gap without a reset (recurring, not one-shot)', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
    expect(state.lastFiredAtRound.current).toBe(TURNS_SINCE_TODO_UPDATE_REMINDER);
    // TURNS_BETWEEN_REMINDERS more rounds of continued no-update elapse → fires
    // again with NO intervening reset. This is the core of the recurring fix.
    state.roundsSinceUpdate.current =
      TURNS_SINCE_TODO_UPDATE_REMINDER + TURNS_BETWEEN_REMINDERS;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
    expect(state.lastFiredAtRound.current).toBe(
      TURNS_SINCE_TODO_UPDATE_REMINDER + TURNS_BETWEEN_REMINDERS,
    );
  });

  it('re-arms after a reset (new run-of-no-updates)', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    shouldFireTodoReminder(state, store);
    resetTodoReminderState(state);
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
  });

  // FEATURE_151 (v0.7.38) — front gate `!hasItems()` REMOVED. Empty store
  // now also fires (with the LLM-self-init nudge text). The previous
  // behavior was a chicken-and-egg deadlock that prevented the LLM from
  // ever learning about the plan-list infrastructure when Scout did not
  // seed.
  it('FEATURE_151: fires even when store has no items (LLM nudged to op:init)', () => {
    const state = createTodoReminderState();
    const emptyStore = createTodoStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER + 100;
    expect(shouldFireTodoReminder(state, emptyStore)).toBe(true);
  });
});

describe('agent transition detection', () => {
  it('first call returns false (no prior agent)', () => {
    const state = createTodoReminderState();
    expect(detectAgentTransition(state, 'KodaXScout')).toBe(false);
    expect(state.lastSeenAgentName.current).toBe('KodaXScout');
  });

  it('subsequent call with same agent returns false', () => {
    const state = createTodoReminderState();
    detectAgentTransition(state, 'KodaXScout');
    expect(detectAgentTransition(state, 'KodaXScout')).toBe(false);
  });

  it('subsequent call with different agent returns true', () => {
    const state = createTodoReminderState();
    detectAgentTransition(state, 'KodaXScout');
    expect(detectAgentTransition(state, 'KodaXGenerator')).toBe(true);
  });

  it('back-and-forth transitions all return true', () => {
    const state = createTodoReminderState();
    detectAgentTransition(state, 'KodaXScout');
    expect(detectAgentTransition(state, 'KodaXGenerator')).toBe(true);
    expect(detectAgentTransition(state, 'KodaXEvaluator')).toBe(true);
    expect(detectAgentTransition(state, 'KodaXGenerator')).toBe(true);
  });
});

describe('throttle reminder text format', () => {
  it('limits a late empty-plan reminder to remaining work without excusing unfinished verification', () => {
    const text = buildTodoReminderText(createTodoStore(), 8);
    expect(text).toContain('multiple execution steps remain');
    expect(text).toContain('Do not create milestones for already completed work');
    expect(text).toContain('one action remains, perform it directly');
    expect(text).toContain('requested work and verification are complete, deliver the result directly');
    expect(text).toContain('Missing or failed checks remain unfinished work');
    expect(text).toContain('without an extra response solely for bookkeeping');
    expect(text).not.toContain('If this task has ≥2 distinct execution steps');
  });

  it('matches the design-doc literal for the standard case', () => {
    const store = makeSeededStore();
    const text = buildTodoReminderText(store);
    // Header line matches the design literal exactly (modulo TURNS const).
    expect(text).toContain(
      `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations. Pending items:`,
    );
    // Each open item appears as a bullet with `id: content` format.
    expect(text).toContain('- todo_1: Locate test fixtures');
    expect(text).toContain('- todo_2: Run migration tests');
    expect(text).toContain('- todo_3: Update type definitions');
    // Closing line exactly matches the design literal.
    expect(text).toContain('If you have started or finished any of these, call todo_update now.');
    // FEATURE_151 (v0.7.38): suppression discipline — model must not
    // surface the reminder to the user.
    expect(text).toContain('NEVER mention this reminder to the user.');
    // Wrapped in <system-reminder> tags for Anthropic-style recognition.
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('uses the live round count on recurring re-fires (not a hardcoded threshold)', () => {
    const store = makeSeededStore();
    // Default (no count arg) reads as the threshold so the first fire AND the
    // pinned benchmark fixture stay byte-stable ("in 8 iterations").
    expect(buildTodoReminderText(store)).toContain(
      `You have not called todo_update in ${TURNS_SINCE_TODO_UPDATE_REMINDER} iterations`,
    );
    // A later recurring fire passes the real elapsed count (e.g. 16 at the
    // second fire), so the message is factually accurate, not stuck at 8.
    const secondFire = TURNS_SINCE_TODO_UPDATE_REMINDER + TURNS_BETWEEN_REMINDERS;
    expect(buildTodoReminderText(store, secondFire)).toContain(
      `You have not called todo_update in ${secondFire} iterations`,
    );
  });

  it('only lists non-terminal items (pending / in_progress / failed)', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', subject: 'Step A' },
      { id: 'todo_2', subject: 'Step B' },
      { id: 'todo_3', subject: 'Step C' },
      { id: 'todo_4', subject: 'Step D' },
    ]);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'skipped');
    store.updateStatus('todo_3', 'in_progress');
    // todo_4 stays pending
    const text = buildTodoReminderText(store);
    expect(text).toContain('- todo_3: Step C');
    expect(text).toContain('- todo_4: Step D');
    expect(text).not.toContain('todo_1');
    expect(text).not.toContain('todo_2');
  });

  it('lists failed items so the model knows what to retry', () => {
    const store = makeSeededStore();
    store.updateStatus('todo_2', 'failed', 'Evaluator requested revision');
    const text = buildTodoReminderText(store);
    expect(text).toContain('- todo_2: Run migration tests');
  });

  it('falls back to short form when every item is terminal', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', subject: 'A' },
      { id: 'todo_2', subject: 'B' },
    ]);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'skipped');
    const text = buildTodoReminderText(store);
    expect(text).toContain('terminal state');
    expect(text).not.toMatch(/^- todo_/m); // no bullet list
    // FEATURE_151 (v0.7.38): suppression discipline applies here too.
    expect(text).toContain('NEVER mention this reminder to the user.');
  });

  // v0.7.42 — empty-store branch nudges LLM to a batch of `todo_create`
  // calls (claudecode V2 parity, no whole-list write surface).
  it('v0.7.42: empty store reminder nudges LLM toward a batch of todo_create', () => {
    const emptyStore = createTodoStore();
    const text = buildTodoReminderText(emptyStore);
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.endsWith('</system-reminder>')).toBe(true);
    expect(text).toContain('have not committed a plan');
    expect(text).toContain('todo_create');
    // Must mention the trivial-task exemption so the LLM doesn't spam plans.
    expect(text).toContain('Trivial');
    // Must NOT show the v0.7.34 'Pending items:' bullet header.
    expect(text).not.toContain('Pending items:');
    // Must NOT regress to teaching op:'init' (deprecated in v0.7.42).
    expect(text).not.toContain('op:"init"');
  });

  it('FEATURE_151: empty store reminder lists no bullet items (defensive)', () => {
    const emptyStore = createTodoStore();
    const text = buildTodoReminderText(emptyStore);
    expect(text).not.toMatch(/^- /m);
  });
});

describe('end-to-end throttle scenario', () => {
  it('classic 8-round-no-update scenario fires once, then suppresses, then re-fires after reset', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();

    // Simulate 8 adapter calls with no todo_update in between.
    let firedCount = 0;
    for (let i = 0; i < 10; i++) {
      if (shouldFireTodoReminder(state, store)) firedCount++;
      tickTodoReminder(state);
    }
    expect(firedCount).toBe(1);

    // Model finally calls todo_update → reset.
    resetTodoReminderState(state);

    // Another long quiet stretch.
    for (let i = 0; i < 10; i++) {
      if (shouldFireTodoReminder(state, store)) firedCount++;
      tickTodoReminder(state);
    }
    expect(firedCount).toBe(2);
  });

  it('FEATURE_151 + recurring: fires at threshold then every TURNS_BETWEEN_REMINDERS while drifting', () => {
    const state = createTodoReminderState();
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'sole task' }]);
    let firedCount = 0;
    for (let i = 0; i < 20; i++) {
      if (shouldFireTodoReminder(state, store)) firedCount++;
      tickTodoReminder(state);
    }
    // Front gate removed (fires even at 1 item). Over 20 rounds of continued
    // no-update with threshold 8 + gap 8, the reminder fires at round 8 and
    // again at round 16 — recurring pressure, not a single one-shot nudge.
    expect(firedCount).toBe(2);
  });
});
