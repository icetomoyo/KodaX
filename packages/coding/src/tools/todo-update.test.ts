/**
 * Hermetic tests for the todo_update tool (FEATURE_097, v0.7.34). No LLM calls.
 * Coverage targets §5 决策细节 ⑤ (unknown-id self-recovery contract).
 */
import { describe, expect, it } from 'vitest';

import { createTodoStore } from '../task-engine/todo-store.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolTodoUpdate } from './todo-update.js';

function makeContext(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeContextWithStore(
  seeds: ReadonlyArray<{ id: string; content: string }> = [
    { id: 'todo_1', content: 'Rename function' },
    { id: 'todo_2', content: 'Update callers' },
    { id: 'todo_3', content: 'Run typecheck' },
  ],
): {
  ctx: KodaXToolExecutionContext;
  store: ReturnType<typeof createTodoStore>;
  notifyCount: () => number;
} {
  let calls = 0;
  const store = createTodoStore({
    onChange: () => {
      calls++;
    },
  });
  store.init(seeds.map((s) => ({ id: s.id, content: s.content })));
  // init counts as call 1; reset for clarity.
  const initCalls = calls;
  return {
    ctx: makeContext({ todoStore: store }),
    store,
    notifyCount: () => calls - initCalls,
  };
}

describe('todo_update happy path', () => {
  it('returns {ok:true} and updates store on a valid call', async () => {
    const { ctx, store, notifyCount } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'in_progress' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(store.getAll()[0]?.status).toBe('in_progress');
    expect(notifyCount()).toBe(1);
  });

  it('attaches note when supplied', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 'tests failed' },
      ctx,
    );
    expect(store.getAll()[0]?.status).toBe('failed');
    expect(store.getAll()[0]?.note).toBe('tests failed');
  });

  it('preserves existing note when called without note arg', async () => {
    const { ctx, store } = makeContextWithStore();
    await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 'original note' },
      ctx,
    );
    await toolTodoUpdate({ id: 'todo_1', status: 'in_progress' }, ctx);
    expect(store.getAll()[0]?.note).toBe('original note');
  });
});

describe('todo_update §5 ⑤ unknown id contract', () => {
  it('returns {ok:false, reason} listing every valid id when id is unknown', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_99', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    // The reason MUST include the rejected id and ALL valid ids so the
    // model can pick a correct one on the next turn.
    expect(parsed.reason).toContain('todo_99');
    expect(parsed.reason).toContain('todo_1');
    expect(parsed.reason).toContain('todo_2');
    expect(parsed.reason).toContain('todo_3');
  });

  it('returns {ok:false} but does NOT mutate the store on unknown id', async () => {
    const { ctx, store, notifyCount } = makeContextWithStore();
    await toolTodoUpdate({ id: 'todo_99', status: 'completed' }, ctx);
    expect(store.getAll().every((it) => it.status === 'pending')).toBe(true);
    expect(notifyCount()).toBe(0);
  });

  it('handles empty store gracefully (no todos seeded yet)', async () => {
    let calls = 0;
    const store = createTodoStore({ onChange: () => calls++ });
    // Do NOT call init — the tool must handle an empty store.
    const ctx = makeContext({ todoStore: store });
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    // Reason should hint that the list is empty rather than offer
    // a bogus comma-list.
    expect(parsed.reason.toLowerCase()).toContain('no todos');
    expect(calls).toBe(0);
  });

  it('handles Planner replace() race: stale id gets a fresh valid-id list', async () => {
    const { ctx, store } = makeContextWithStore();
    // Planner fully replaces — old todo_1..todo_3 disappear.
    store.replace([
      { id: 'p_1', content: 'planner step a', status: 'pending' },
      { id: 'p_2', content: 'planner step b', status: 'pending' },
    ]);
    // Generator (running on stale ids) tries to update the old id.
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('todo_1');
    expect(parsed.reason).toContain('p_1');
    expect(parsed.reason).toContain('p_2');
    // Old id list must NOT be in the reason.
    expect(parsed.reason).not.toContain('todo_2');
    expect(parsed.reason).not.toContain('todo_3');
  });
});

describe('todo_update input validation', () => {
  it('returns {ok:false} when id is missing', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ status: 'in_progress' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
    expect(JSON.parse(result).reason).toContain('id');
  });

  it('returns {ok:false} when id is non-string', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 42 as unknown as string, status: 'in_progress' },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when id is empty string', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: '', status: 'in_progress' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when status is missing', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate({ id: 'todo_1' }, ctx);
    expect(JSON.parse(result).ok).toBe(false);
    expect(JSON.parse(result).reason.toLowerCase()).toContain('status');
  });

  it('returns {ok:false} on invalid status (not in allowed enum)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'archived' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('archived');
    expect(parsed.reason).toContain('in_progress');
  });

  it('rejects pending as a status (it is set automatically by store, not the tool)', async () => {
    // Per design, models cannot reset items to pending via todo_update —
    // that's resetFailed()'s job (Runner-driven on revise → next-iter).
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'pending' },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('returns {ok:false} when note is non-string and non-undefined', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'failed', note: 42 as unknown as string },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(false);
  });

  it('accepts note=undefined (treated as omitted)', async () => {
    const { ctx } = makeContextWithStore();
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed', note: undefined },
      ctx,
    );
    expect(JSON.parse(result).ok).toBe(true);
  });
});

describe('todo_update graceful degradation when store is not wired', () => {
  it('returns {ok:false} explaining todo_update is inactive (no throw)', async () => {
    // Simulates: Scout did not produce ≥2 obligations, so runner-driven
    // never wired the store. The tool was still injected to the toolset
    // (Scout/Generator/Planner all get it unconditionally), so the model
    // CAN call it — it just gets a soft refusal.
    const ctx = makeContext({ todoStore: undefined });
    const result = await toolTodoUpdate(
      { id: 'todo_1', status: 'completed' },
      ctx,
    );
    const parsed = JSON.parse(result) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason.toLowerCase()).toContain('not active');
  });
});
