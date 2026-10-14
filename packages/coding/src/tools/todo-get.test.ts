/**
 * Hermetic tests for the `todo_get` tool — v0.7.42 plan-list parity with
 * claudecode V2 `TaskGet`.
 *
 * Read-only single-item lookup. These tests pin:
 *   - Empty store / unwired → soft-fail with "not active" reason.
 *   - Missing or empty id → input-validation soft-fail.
 *   - Unknown id → `Unknown todo id ...` reason carrying the valid-id
 *     list (mirrors `todo_update`'s recovery hint surface).
 *   - Found id → `{ ok: true, item: {...} }` envelope with stable shape;
 *     optional fields omitted when absent so prompt-cache hits stay stable.
 *   - Non-mutation: calling `todo_get` does NOT fire `onChange`.
 */
import { describe, expect, it } from 'vitest';

import { createTodoStore } from '../task-engine/todo-store.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolTodoGet } from './todo-get.js';

function makeContext(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

describe('todo_get — soft-fail when not wired', () => {
  it('returns {ok:false, reason:"not active ..."} when todoStore is undefined', async () => {
    const ctx = makeContext({ todoStore: undefined });
    const result = await toolTodoGet({ id: 'todo_1' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain('not active');
  });
});

describe('todo_get — input validation', () => {
  it('returns {ok:false, reason:"Missing or invalid ..."} when id is missing', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'A' }]);
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({}, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/id.*non-empty/i);
  });

  it('returns {ok:false, reason:"Missing or invalid ..."} when id is empty string', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'A' }]);
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({ id: '' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/id.*non-empty/i);
  });

  it('returns {ok:false, reason:"Missing or invalid ..."} when id is non-string', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'A' }]);
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({ id: 42 } as Record<string, unknown>, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/id.*non-empty/i);
  });
});

describe('todo_get — unknown id recovery hint', () => {
  it('returns {ok:false, reason} with the valid-id list when id is unknown', async () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', subject: 'A' },
      { id: 'todo_2', subject: 'B' },
    ]);
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({ id: 'todo_99' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('Unknown todo id');
    expect(parsed.reason).toContain('todo_99');
    // Recovery hint: lists currently-valid ids so the model can retry.
    expect(parsed.reason).toContain('todo_1');
    expect(parsed.reason).toContain('todo_2');
    expect(parsed.reason).toMatch(/todo_list/i);
  });

  it('returns a "no todos currently exist" hint when the store is empty', async () => {
    const store = createTodoStore();
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({ id: 'todo_1' }, ctx);
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('Unknown todo id');
    expect(parsed.reason).toContain('no todos currently exist');
  });
});

describe('todo_get — populated store', () => {
  it('reads caller-supplied owner provenance without inventing an owner for legacy items', async () => {
    const store = createTodoStore();
    store.init([
      { id: 'owned', subject: 'Review auth', owner: '/root/auth' },
      { id: 'legacy', subject: 'Integrate findings' },
    ]);
    const ctx = makeContext({ todoStore: store });
    const owned = JSON.parse(await toolTodoGet({ id: 'owned' }, ctx)) as {
      item: { owner?: string; status: string };
    };
    const legacy = JSON.parse(await toolTodoGet({ id: 'legacy' }, ctx)) as {
      item: { owner?: string; status: string };
    };
    expect(owned.item.owner).toBe('/root/auth');
    expect(legacy.item).not.toHaveProperty('owner');
    expect(store.getAll().map(item => item.status)).toEqual(['pending', 'pending']);
  });

  it('returns the full item with stable JSON envelope shape', async () => {
    let onChangeCalls = 0;
    const store = createTodoStore({ onChange: () => onChangeCalls++ });
    store.init([
      {
        id: 'todo_1',
        subject: 'Audit packages/llm',
        description: 'Look for circular deps, dead exports, and stale stubs.',
        activeForm: 'Auditing packages/llm',
      },
      { id: 'todo_2', subject: 'Update tests' },
    ]);
    store.updateStatus('todo_1', 'in_progress');
    onChangeCalls = 0; // reset so we can verify get is read-only

    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoGet({ id: 'todo_1' }, ctx);
    const parsed = JSON.parse(result) as {
      ok: boolean;
      item: {
        id: string;
        subject: string;
        description?: string;
        status: string;
        activeForm?: string;
        note?: string;
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.item).toEqual({
      id: 'todo_1',
      subject: 'Audit packages/llm',
      description: 'Look for circular deps, dead exports, and stale stubs.',
      status: 'in_progress',
      activeForm: 'Auditing packages/llm',
    });

    // Read-only: no onChange firing.
    expect(onChangeCalls).toBe(0);
  });

  it('omits absent optional fields so JSON stays compact', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'Plain item' }]);
    const result = await toolTodoGet(
      { id: 'todo_1' },
      makeContext({ todoStore: store }),
    );
    const parsed = JSON.parse(result) as { item: Record<string, unknown> };
    expect(parsed.item).toEqual({
      id: 'todo_1',
      subject: 'Plain item',
      status: 'pending',
    });
    // Verify absence by checking key set (no description / activeForm /
    // note / evaluator / metadata noise).
    expect(Object.keys(parsed.item).sort()).toEqual(
      ['subject', 'id', 'status'].sort(),
    );
  });

  it('preserves a failed-item note in the output', async () => {
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'Run tests' }]);
    store.updateStatus('todo_1', 'failed', 'tests timed out');
    const result = await toolTodoGet(
      { id: 'todo_1' },
      makeContext({ todoStore: store }),
    );
    const parsed = JSON.parse(result) as { item: Record<string, unknown> };
    expect(parsed.item.note).toBe('tests timed out');
    expect(parsed.item.status).toBe('failed');
  });

  it('returns metadata and evaluator when present', async () => {
    const store = createTodoStore();
    store.init([
      {
        id: 'todo_1',
        subject: 'Run unit tests',
        evaluator: 'test',
      },
    ]);
    store.patch('todo_1', { metadata: { source: 'planner', round: 2 } });

    const result = await toolTodoGet(
      { id: 'todo_1' },
      makeContext({ todoStore: store }),
    );
    const parsed = JSON.parse(result) as { item: Record<string, unknown> };
    expect(parsed.item.evaluator).toBe('test');
    expect(parsed.item.metadata).toEqual({ source: 'planner', round: 2 });
  });

  it('drills into the requested id even when many items exist', async () => {
    const store = createTodoStore();
    store.init([
      { id: 'todo_1', subject: 'A' },
      { id: 'todo_2', subject: 'B' },
      { id: 'todo_3', subject: 'C', description: 'The one we want' },
      { id: 'todo_4', subject: 'D' },
      { id: 'todo_5', subject: 'E' },
    ]);
    const result = await toolTodoGet(
      { id: 'todo_3' },
      makeContext({ todoStore: store }),
    );
    const parsed = JSON.parse(result) as {
      ok: boolean;
      item: { id: string; subject: string; description?: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.item.id).toBe('todo_3');
    expect(parsed.item.subject).toBe('C');
    expect(parsed.item.description).toBe('The one we want');
  });
});

describe('todo_get — staleness refresh use case', () => {
  it('reflects status updates that happen between the list and the get call', async () => {
    // Simulates the use case the tool exists for: model calls todo_list,
    // then before mutating one item via todo_update calls todo_get to
    // refresh that item's status (the runner-side auto-handler or another
    // turn may have flipped it).
    const store = createTodoStore();
    store.init([{ id: 'todo_1', subject: 'Do thing' }]);
    // Snapshot a stale view (would have status: 'pending').
    store.updateStatus('todo_1', 'in_progress', undefined, 'Doing thing');
    // Auto-handler / parallel turn flips it to completed before the model
    // mutates.
    store.updateStatus('todo_1', 'completed');

    const result = await toolTodoGet(
      { id: 'todo_1' },
      makeContext({ todoStore: store }),
    );
    const parsed = JSON.parse(result) as {
      item: { status: string; activeForm?: string };
    };
    expect(parsed.item.status).toBe('completed');
    // activeForm is preserved across status transitions so the spinner
    // history is auditable from todo_get's output.
    expect(parsed.item.activeForm).toBe('Doing thing');
  });
});
