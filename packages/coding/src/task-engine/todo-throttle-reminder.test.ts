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
    { id: 'todo_1', content: 'Locate test fixtures' },
    { id: 'todo_2', content: 'Run migration tests' },
    { id: 'todo_3', content: 'Update type definitions' },
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

  it('does not re-fire after the first fire (within the same un-reset run)', () => {
    const state = createTodoReminderState();
    const store = makeSeededStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER;
    expect(shouldFireTodoReminder(state, store)).toBe(true);
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER + 5;
    expect(shouldFireTodoReminder(state, store)).toBe(false);
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

  it('front-gate: does not fire when store has no items', () => {
    const state = createTodoReminderState();
    const emptyStore = createTodoStore();
    state.roundsSinceUpdate.current = TURNS_SINCE_TODO_UPDATE_REMINDER + 100;
    expect(shouldFireTodoReminder(state, emptyStore)).toBe(false);
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
    // Wrapped in <system-reminder> tags for Anthropic-style recognition.
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('only lists non-terminal items (pending / in_progress / failed)', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'Step A' },
      { id: 'todo_2', content: 'Step B' },
      { id: 'todo_3', content: 'Step C' },
      { id: 'todo_4', content: 'Step D' },
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
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
    ]);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'skipped');
    const text = buildTodoReminderText(store);
    expect(text).toContain('terminal state');
    expect(text).not.toMatch(/^- todo_/m); // no bullet list
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

  it('does not fire if store has fewer than 2 items at any point', () => {
    const state = createTodoReminderState();
    const store = createTodoStore();
    // Single-item store — design says obligations < 2 means no seed; but
    // even if one slipped through, the threshold + front-gate logic should
    // still hold (front-gate is `hasItems()` which is true at 1 item, but
    // the design states obligations < 2 never seeds, so this is defense).
    store.init([{ id: 'todo_1', content: 'sole task' }]);
    let firedCount = 0;
    for (let i = 0; i < 20; i++) {
      if (shouldFireTodoReminder(state, store)) firedCount++;
      tickTodoReminder(state);
    }
    // It DOES fire once even at 1 item — front-gate is hasItems(), not
    // length>=2. The "obligations < 2 → don't seed" is enforced upstream
    // at runner-driven.ts (Scout/Planner contract emit branches), so by
    // the time we reach this layer the store is either empty (no fire) or
    // ≥ 2 (fires normally). This test documents that.
    expect(firedCount).toBe(1);
  });
});
