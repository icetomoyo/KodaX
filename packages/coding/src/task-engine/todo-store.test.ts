/**
 * Hermetic tests for todo-store (FEATURE_097, v0.7.34). No LLM calls.
 */
import { describe, expect, it } from 'vitest';

import type { TodoList, TodoStatus } from '../types.js';
import { createTodoStore, type TodoInit } from './todo-store.js';

const SEEDS: readonly TodoInit[] = Object.freeze([
  { id: 'todo_1', content: 'Rename function', owner: 'main', sourceObligationIndex: 0 },
  { id: 'todo_2', content: 'Update callers', owner: 'main', sourceObligationIndex: 1 },
  { id: 'todo_3', content: 'Run typecheck', owner: 'main', sourceObligationIndex: 2 },
]);

describe('todo-store basics', () => {
  it('starts empty', () => {
    const store = createTodoStore();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
    expect(store.allIds()).toEqual([]);
  });

  it('init() seeds items as pending', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.hasItems()).toBe(true);
    expect(store.allIds()).toEqual(['todo_1', 'todo_2', 'todo_3']);
    for (const it of store.getAll()) {
      expect(it.status).toBe('pending');
      expect(it.note).toBeUndefined();
    }
  });

  it('has() returns true only for existing ids', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.has('todo_2')).toBe(true);
    expect(store.has('todo_99')).toBe(false);
    expect(store.has('')).toBe(false);
  });

  it('reset() drops every item', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.reset();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
  });

  it('replace() swaps the entire list', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.replace([
      { id: 'p_1', content: 'planned step a', status: 'pending' },
      { id: 'p_2', content: 'planned step b', status: 'pending' },
    ]);
    expect(store.allIds()).toEqual(['p_1', 'p_2']);
    expect(store.has('todo_1')).toBe(false);
  });
});

describe('todo-store updateStatus', () => {
  it('returns true and updates status when id exists', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.updateStatus('todo_2', 'in_progress')).toBe(true);
    const items = store.getAll();
    expect(items[1]?.status).toBe('in_progress');
    // Other items untouched.
    expect(items[0]?.status).toBe('pending');
    expect(items[2]?.status).toBe('pending');
  });

  it('returns false and is a no-op when id is unknown', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    expect(store.updateStatus('todo_99', 'completed')).toBe(false);
    expect(store.getAll().every((it) => it.status === 'pending')).toBe(true);
  });

  it('attaches note on update', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'Evaluator requested revision');
    expect(store.getAll()[0]?.note).toBe('Evaluator requested revision');
    expect(store.getAll()[0]?.status).toBe('failed');
  });

  it('preserves existing note when called without a note argument', () => {
    // Regression for code-reviewer MEDIUM finding: prior implementation
    // erased existing notes on every status transition that did not
    // explicitly supply one. This matters when a failed item carrying an
    // Evaluator note is later re-tried via updateStatus(id, 'in_progress')
    // with no note — the failure context should remain visible until the
    // model actively replaces it (via a new note) or resetFailed clears it.
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'audit failed: missing scope check');
    // Re-try as in_progress without supplying a note — note must persist.
    store.updateStatus('todo_1', 'in_progress');
    expect(store.getAll()[0]?.status).toBe('in_progress');
    expect(store.getAll()[0]?.note).toBe('audit failed: missing scope check');
  });

  it('replaces note when caller supplies a new one', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'first reason');
    store.updateStatus('todo_1', 'failed', 'second reason');
    expect(store.getAll()[0]?.note).toBe('second reason');
  });

  it('allows terminal-state transitions (lifecycle is not enforced at the store layer)', () => {
    // The design doc describes a one-way lifecycle pending → in_progress →
    // (completed | failed | skipped). The store deliberately does NOT
    // enforce that — the constraint lives in the role-prompt layer (per
    // CLAUDE.md "约束走 prompt 层，代码层不 enforce"). Document the
    // intentional permissiveness with an explicit test so future refactors
    // do not accidentally add validation that violates the design.
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    // Re-opening a completed item is permitted at the store layer.
    expect(store.updateStatus('todo_1', 'failed', 'reopened by reviewer')).toBe(true);
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('reopened by reviewer');
  });

  it('snapshots returned to consumers are frozen and not affected by later mutations', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    const snapshot = store.getAll();
    // Snapshot itself is frozen.
    expect(Object.isFrozen(snapshot)).toBe(true);
    // Mutating store does not retroactively change the snapshot.
    store.updateStatus('todo_1', 'completed');
    expect(snapshot[0]?.status).toBe('pending');
    expect(store.getAll()[0]?.status).toBe('completed');
  });
});

describe('todo-store Evaluator verdict auto-handling (§5 决策细节 ①)', () => {
  it('autoCompleteOnAccept on an empty store returns 0 and is a no-op', () => {
    // Edge case: replan → reset → accept race ordering. The verdict can
    // arrive after the list was cleared. Must not throw, must report 0.
    const store = createTodoStore();
    expect(store.autoCompleteOnAccept()).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it('autoCompleteOnAccept flips pending + in_progress to completed', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_2', 'in_progress');
    expect(store.autoCompleteOnAccept()).toBe(3); // all 3 changed
    expect(store.getAll().every((it) => it.status === 'completed')).toBe(true);
  });

  it('autoCompleteOnAccept does not affect already completed/failed/skipped', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'failed');
    store.updateStatus('todo_3', 'skipped');
    expect(store.autoCompleteOnAccept()).toBe(0);
    expect(store.getAll().map((it) => it.status)).toEqual([
      'completed',
      'failed',
      'skipped',
    ]);
  });

  it('markInProgressFailed flips only in_progress items, attaches note', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'in_progress');
    expect(store.markInProgressFailed('Evaluator requested revision')).toBe(1);
    const items = store.getAll();
    expect(items[0]?.status).toBe('completed'); // unchanged
    expect(items[1]?.status).toBe('failed');
    expect(items[1]?.note).toBe('Evaluator requested revision');
    expect(items[2]?.status).toBe('pending'); // unchanged
  });

  it('resetFailed flips failed items back to pending and clears their note', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'failed', 'previous reason');
    store.updateStatus('todo_2', 'completed');
    expect(store.resetFailed()).toBe(1);
    const items = store.getAll();
    expect(items[0]?.status).toBe('pending');
    expect(items[0]?.note).toBeUndefined();
    expect(items[1]?.status).toBe('completed'); // unchanged
  });

  it('full revise → reset cycle: in_progress → failed → pending', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'in_progress');

    // Evaluator returns revise.
    expect(store.markInProgressFailed('audit failed')).toBe(1);
    expect(store.getAll()[1]?.status).toBe('failed');

    // Next iteration starts.
    expect(store.resetFailed()).toBe(1);
    expect(store.getAll()[1]?.status).toBe('pending');
    expect(store.getAll()[1]?.note).toBeUndefined();
  });
});

describe('todo-store onChange callback', () => {
  it('does not fire onChange before any mutation', () => {
    const calls: number[] = [];
    createTodoStore({ onChange: (items) => calls.push(items.length) });
    expect(calls).toEqual([]);
  });

  it('fires onChange on init() with the seeded list', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items.length) });
    store.init(SEEDS);
    expect(calls).toEqual([3]);
  });

  it('fires onChange on successful updateStatus, but NOT on unknown id', () => {
    const calls: string[][] = [];
    const store = createTodoStore({
      onChange: (items) => calls.push(items.map((it) => it.status)),
    });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'in_progress'); // call 2
    store.updateStatus('todo_99', 'completed'); // unknown id — no call
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('does NOT fire onChange when updateStatus is called with the same status + same note (LLM double-call guard)', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'in_progress'); // call 2 (transition)
    store.updateStatus('todo_1', 'in_progress'); // no-op same status, no note → no call
    store.updateStatus('todo_1', 'in_progress'); // no-op again → no call
    expect(calls).toBe(2);
  });

  it('fires onChange when updateStatus changes the note even if status is unchanged', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init(SEEDS); // call 1
    store.updateStatus('todo_1', 'failed', 'first reason'); // call 2
    store.updateStatus('todo_1', 'failed', 'first reason'); // no-op → no call
    store.updateStatus('todo_1', 'failed', 'updated reason'); // call 3 (note changed)
    expect(calls).toBe(3);
  });

  it('fires onChange on replace()', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items.length) });
    store.init(SEEDS); // call 1
    store.replace([{ id: 'p_1', content: 'new', status: 'pending' }]); // call 2
    expect(calls).toEqual([3, 1]);
  });

  it('fires onChange on autoCompleteOnAccept only when items actually change', () => {
    const calls: string[][] = [];
    const store = createTodoStore({
      onChange: (items) => calls.push(items.map((it) => it.status)),
    });
    store.init(SEEDS); // call 1: all pending
    store.autoCompleteOnAccept(); // call 2: pending → completed
    store.autoCompleteOnAccept(); // no-op: all already completed → no call
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(['completed', 'completed', 'completed']);
  });

  it('fires onChange on markInProgressFailed only when there are in_progress items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.init(SEEDS); // call 1
    store.markInProgressFailed('reason'); // no in_progress → no call
    store.updateStatus('todo_1', 'in_progress'); // call 2
    store.markInProgressFailed('reason'); // call 3
    expect(calls.length).toBe(3);
  });

  it('fires onChange on resetFailed only when there are failed items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.init(SEEDS); // call 1
    store.resetFailed(); // no failed → no call
    store.updateStatus('todo_1', 'failed', 'reason'); // call 2
    store.resetFailed(); // call 3
    expect(calls.length).toBe(3);
  });

  it('fires onChange on reset() only when store had items', () => {
    const calls: number[] = [];
    const store = createTodoStore({ onChange: () => calls.push(1) });
    store.reset(); // empty already → no call
    store.init(SEEDS); // call 1
    store.reset(); // call 2
    store.reset(); // empty already → no call
    expect(calls.length).toBe(2);
  });

  it('passes a frozen snapshot, not the live array', () => {
    const calls: TodoList[] = [];
    const store = createTodoStore({ onChange: (items) => calls.push(items) });
    store.init(SEEDS);
    expect(Object.isFrozen(calls[0])).toBe(true);
    // Subsequent mutations do not retroactively change earlier snapshots.
    store.updateStatus('todo_1', 'completed');
    expect(calls[0]?.[0]?.status).toBe('pending');
    expect(calls[1]?.[0]?.status).toBe('completed');
  });
});

describe('todo-store immutability invariant', () => {
  it('updateStatus returns new objects (does not mutate prior snapshot)', () => {
    const store = createTodoStore();
    store.init(SEEDS);
    const before = store.getAll();
    const beforeRef = before[1];
    store.updateStatus('todo_2', 'in_progress');
    const afterRef = store.getAll()[1];
    expect(beforeRef).not.toBe(afterRef);
    expect(beforeRef?.status).toBe('pending');
    expect(afterRef?.status).toBe('in_progress');
  });
});

// FEATURE_097 (v0.7.34) §5 ① cross-turn lifecycle — pinpoints the
// runner-driven.ts contract that the wrapEmitterWithRecorder verdict
// slot arms `pendingFailedResetRef` after a `revise` and the next
// Generator turn's `instructions` closure consumes it. The ref itself
// lives in runner-driven.ts; this test exercises the store-level
// contract end-to-end so a future regression that drops either side
// of the contract is caught at the unit layer rather than waiting for
// integration tests to detect it.
describe('todo-store revise → reset cross-turn lifecycle (FEATURE_097 §5 ①)', () => {
  it('markInProgressFailed → resetFailed produces the ●→✗→☐ visual sequence', () => {
    const snapshots: ReadonlyArray<{ status: TodoStatus; note?: string }>[] = [];
    const store = createTodoStore({
      onChange: (items) => {
        snapshots.push(
          items.map((it) => ({ status: it.status, note: it.note })),
        );
      },
    });
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
      { id: 'todo_3', content: 'C' },
    ]);
    // Phase 1: Generator marks todo_1 + todo_2 in_progress (sequential).
    store.updateStatus('todo_1', 'in_progress');
    store.updateStatus('todo_2', 'in_progress');
    // Phase 2: Evaluator revise — wrapEmitterWithRecorder calls
    // markInProgressFailed; pendingFailedResetRef arms.
    const failedCount = store.markInProgressFailed('Evaluator requested revision');
    expect(failedCount).toBe(2);
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('Evaluator requested revision');
    // Phase 3: Generator's next-turn instructions closure consumes
    // the flag and calls resetFailed; failed → pending.
    const resetCount = store.resetFailed();
    expect(resetCount).toBe(2);
    expect(store.getAll()[0]?.status).toBe('pending');
    expect(store.getAll()[0]?.note).toBeUndefined();
    expect(store.getAll()[2]?.status).toBe('pending'); // unchanged
    // The full visual sequence: init → in_prog → in_prog → failed → pending.
    // Each transition must have produced exactly one onChange call.
    expect(snapshots.length).toBe(5);
  });

  it('idempotent on second resetFailed: no extra onChange (the flag is already cleared)', () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    store.markInProgressFailed('reason');
    store.resetFailed();
    const callsAtSettled = calls;
    // If the runner-driven flag handling re-fires resetFailed
    // accidentally (lifecycle bug), no items are in `failed` state, so
    // the second call should be a true no-op.
    store.resetFailed();
    expect(calls).toBe(callsAtSettled);
  });

  it('replan path is distinguishable: store.reset() empties the list', () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', content: 'A' },
      { id: 'todo_2', content: 'B' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    // §5 ① replan disposition routes through `reset()` (not
    // markInProgressFailed). Distinguishes "retry these items" from
    // "abandon the list, Planner refines".
    store.reset();
    expect(store.hasItems()).toBe(false);
    expect(store.getAll()).toEqual([]);
  });
});
