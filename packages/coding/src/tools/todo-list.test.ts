/**
 * Hermetic tests for the `todo_list` tool — FEATURE_151 (v0.7.38) Slice D.
 *
 * Read-only query that returns the current visible plan list as JSON,
 * mirroring Claude Code's `TaskListTool`. These tests pin:
 *   - Empty store → soft-fail with "not active" reason (matching the
 *     `todo_update` graceful-degradation contract).
 *   - Populated store → `{ ok: true, count, items }` envelope shape.
 *   - Optional fields (`activeForm`, `note`) are omitted when absent so
 *     the JSON envelope stays stable for prompt-cache hits.
 *   - Non-mutation: calling `todo_list` does NOT fire `onChange`.
 */
import { describe, expect, it } from 'vitest';

import { createTodoStore } from '../task-engine/todo-store.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolTodoList } from './todo-list.js';

function makeContext(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

describe('todo_list — soft-fail when not wired', () => {
  it('returns {ok:false, reason:"not active ..."} when todoStore is undefined', async () => {
    const ctx = makeContext({ todoStore: undefined });
    const result = await toolTodoList({}, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain('not active');
  });
});

describe('todo_list — populated store', () => {
  it('reads one full item by id without losing detail or mutating the plan', async () => {
    let changes = 0;
    const store = createTodoStore({ onChange: () => changes++ });
    store.init([
      { id: 'review', subject: 'Review changes', owner: '/root/review', evaluator: 'test' },
      { id: 'integrate', subject: 'Integrate results' },
    ]);
    store.patch('review', { metadata: { source: 'planner', round: 2 } });
    store.updateStatus('review', 'completed', 'Tests passed');
    changes = 0;

    expect(JSON.parse(await toolTodoList({ id: 'review' }, makeContext({ todoStore: store })))).toEqual({
      ok: true,
      item: {
        id: 'review', subject: 'Review changes', status: 'completed', note: 'Tests passed',
        owner: '/root/review', evaluator: 'test', metadata: { source: 'planner', round: 2 },
      },
    });
    expect(changes).toBe(0);
  });

  it.each(['', 42, null, undefined])('rejects an explicit invalid id (%s) instead of returning all items', async (id) => {
    const store = createTodoStore();
    store.init([{ id: 'review', subject: 'Review changes' }]);
    const result = JSON.parse(await toolTodoList({ id }, makeContext({ todoStore: store }))) as {
      ok: boolean; reason: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/id.*non-empty/i);
  });

  it('reports valid ids when a requested item no longer exists', async () => {
    const store = createTodoStore();
    store.init([{ id: 'review', subject: 'Review changes' }]);
    const result = JSON.parse(await toolTodoList({ id: 'missing' }, makeContext({ todoStore: store }))) as {
      ok: boolean; reason: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Unknown todo id');
    expect(result.reason).toContain('review');
  });

  it('returns the full list with stable JSON envelope shape', async () => {
    let onChangeCalls = 0;
    const store = createTodoStore({ onChange: () => onChangeCalls++ });
    store.init([
      {
        id: 'todo_1',
        subject: 'Audit packages/llm',
        activeForm: 'Auditing packages/llm',
      },
      { id: 'todo_2', subject: 'Update tests' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    onChangeCalls = 0; // reset counter so we can verify list is read-only

    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoList({}, ctx);
    const parsed = JSON.parse(result) as {
      ok: boolean;
      count: number;
      items: Array<{
        id: string;
        subject: string;
        status: string;
        activeForm?: string;
        note?: string;
      }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toEqual({
      id: 'todo_1',
      subject: 'Audit packages/llm',
      status: 'in_progress',
      activeForm: 'Auditing packages/llm',
    });
    expect(parsed.items[1]).toEqual({
      id: 'todo_2',
      subject: 'Update tests',
      status: 'pending',
    });

    // Read-only: no onChange firing.
    expect(onChangeCalls).toBe(0);
  });

  it('omits absent optional fields (activeForm, note) so JSON stays compact', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'Plain item' }]);
    const result = await toolTodoList({}, makeContext({ todoStore: store }));
    const parsed = JSON.parse(result) as { items: Record<string, unknown>[] };
    expect(parsed.items[0]).toEqual({
      id: 'todo_1',
      subject: 'Plain item',
      status: 'pending',
    });
    // Verify absence by checking key set, not undefined-equality.
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual(
      ['subject', 'id', 'status'].sort(),
    );
  });

  it('preserves a failed-item note in the output', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'Run tests' }]);
    store.updateStatus('todo_1', 'failed', 'tests timed out');
    const result = await toolTodoList({}, makeContext({ todoStore: store }));
    const parsed = JSON.parse(result) as { items: Record<string, unknown>[] };
    expect(parsed.items[0]?.note).toBe('tests timed out');
    expect(parsed.items[0]?.status).toBe('failed');
  });

  it('reflects the current state after a series of updates', async () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', subject: 'A' },
      { id: 'todo_2', subject: 'B' },
      { id: 'todo_3', subject: 'C' },
    ]);
    store.updateStatus('todo_1', 'completed');
    store.updateStatus('todo_2', 'in_progress', undefined, 'Doing B');

    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoList({}, ctx);
    const parsed = JSON.parse(result) as {
      count: number;
      items: Array<{ id: string; status: string; activeForm?: string }>;
    };
    expect(parsed.count).toBe(3);
    expect(parsed.items.map((i) => `${i.id}:${i.status}`)).toEqual([
      'todo_1:completed',
      'todo_2:in_progress',
      'todo_3:pending',
    ]);
    expect(parsed.items[1]?.activeForm).toBe('Doing B');
  });

  it('returns {ok:true, count:0, items:[]} when store was init-cleared (defensive)', async () => {
    // The store does not currently expose a "clear via empty init" path
    // (executeInitOp rejects empty arrays), but the underlying store has
    // `reset()` which the runner uses on the `replan` verdict. Verify
    // todo_list copes with the post-reset empty state.
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'A' }]);
    store.reset();
    const result = await toolTodoList({}, makeContext({ todoStore: store }));
    const parsed = JSON.parse(result) as {
      ok: boolean;
      count: number;
      items: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.items).toEqual([]);
  });
});
