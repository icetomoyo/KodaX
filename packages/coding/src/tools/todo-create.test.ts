/**
 * Hermetic tests for the todo_create tool (FEATURE_170, v0.7.41).
 * No LLM calls. Validates the per-item insertion path, hook gating,
 * and store id allocation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTodoStore } from '../task-engine/todo-store.js';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
} from '../extensions/index.js';
import { toolTodoCreate } from './todo-create.js';
import { extractStructuredToolErrorCode, isToolResultErrorContent } from '../agent-runtime/tool-result-classify.js';

function makeContext(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

function makeContextWithStore(
  seeds: ReadonlyArray<{ id: string; subject: string }> = [],
): { ctx: KodaXToolExecutionContext; store: ReturnType<typeof createTodoStore> } {
  const store = createTodoStore();
  if (seeds.length > 0) {
    store.init(seeds.map((s) => ({ id: s.id, subject: s.subject })));
  }
  return {
    ctx: makeContext({ todoStore: store }),
    store,
  };
}

describe('todo_create happy path', () => {
  it('starts work at creation without a second status mutation or changing existing progress', async () => {
    const changes: string[][] = [];
    const store = createTodoStore({ onChange: items => changes.push(items.map(item => item.status)) });
    const prior = store.add({ subject: 'Earlier work' });
    store.updateStatus(prior, 'completed');
    changes.length = 0;
    const out = await toolTodoCreate({ subject: 'Implement follow-up', status: 'in_progress', evaluator: 'test' }, makeContext({ todoStore: store }));
    expect(JSON.parse(out)).toEqual({ ok: true, id: 'todo_2' });
    expect(changes).toEqual([['completed', 'in_progress']]);
    expect(store.getAll()[1]).toMatchObject({ subject: 'Implement follow-up', status: 'in_progress', evaluator: 'test' });
  });

  it('returns {ok:true, id} and inserts a pending item', async () => {
    const { ctx, store } = makeContextWithStore([
      { id: 'todo_1', subject: 'First' },
    ]);
    const out = await toolTodoCreate({ subject: 'Second step' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; id?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe('todo_2');
    expect(store.has('todo_2')).toBe(true);
    const item = store.getAll().find((it) => it.id === 'todo_2')!;
    expect(item.subject).toBe('Second step');
    expect(item.status).toBe('pending');
  });

  it('carries optional fields (activeForm / evaluator / metadata) into the new item', async () => {
    const { ctx, store } = makeContextWithStore();
    const out = await toolTodoCreate(
      {
        subject: 'Refactor auth',
        activeForm: 'Refactoring auth',
        evaluator: 'build',
        metadata: { feature: 'AUTH-42' },
      },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; id: string };
    expect(parsed.ok).toBe(true);
    const item = store.getAll().find((it) => it.id === parsed.id)!;
    expect(item.activeForm).toBe('Refactoring auth');
    expect(item.evaluator).toBe('build');
    expect(item.metadata).toEqual({ feature: 'AUTH-42' });
  });

  it('returns monotonic ids across consecutive todo_create calls', async () => {
    const { ctx } = makeContextWithStore();
    const a = JSON.parse(await toolTodoCreate({ subject: 'A' }, ctx)) as { id: string };
    const b = JSON.parse(await toolTodoCreate({ subject: 'B' }, ctx)) as { id: string };
    const c = JSON.parse(await toolTodoCreate({ subject: 'C' }, ctx)) as { id: string };
    expect(a.id).toBe('todo_1');
    expect(b.id).toBe('todo_2');
    expect(c.id).toBe('todo_3');
  });
});

describe('todo_create validation', () => {
  it('reports invalid input as a tool failure with its original reason and a source-owned code', async () => {
    const { ctx, store } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: 'Verify', status: 'completed' }, ctx);
    expect(JSON.parse(out)).toEqual({ ok: false,
      reason: 'Invalid status: use pending (default) or in_progress for work starting now.', code: 'todo_invalid_input' });
    expect(isToolResultErrorContent(out)).toBe(true);
    expect(extractStructuredToolErrorCode(out)).toBe('todo_invalid_input');
    expect(store.hasItems()).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled', 'skipped', null, 1])('rejects initial status %s without allocating an item', async status => {
    const { ctx, store } = makeContextWithStore();
    expect(JSON.parse(await toolTodoCreate({ subject: 'Verify', status }, ctx))).toMatchObject({ ok: false });
    expect(store.getAll()).toEqual([]);
    expect(JSON.parse(await toolTodoCreate({ subject: 'Valid work', status: 'pending' }, ctx))).toEqual({ ok: true, id: 'todo_1' });
  });

  it('returns {ok:false} when store is not wired', async () => {
    const ctx = makeContext({ todoStore: undefined });
    const out = await toolTodoCreate({ subject: 'X' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/todo_create is not active/);
  });

  it('rejects empty content', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: '' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/subject.*non-empty string/);
  });

  it('rejects missing content', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate({}, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/subject.*non-empty string/);
  });

  it('rejects non-string content (e.g. number)', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: 42 } as Record<string, unknown>, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/subject.*non-empty string/);
  });

  it('rejects non-string activeForm', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate(
      { subject: 'X', activeForm: 99 } as Record<string, unknown>,
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/activeForm/);
  });

  it('rejects invalid evaluator value', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate(
      { subject: 'X', evaluator: 'typecheck' } as Record<string, unknown>,
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/evaluator.*build.*test.*lint/);
  });

  it('rejects non-object metadata (e.g. array)', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate(
      { subject: 'X', metadata: [1, 2, 3] } as Record<string, unknown>,
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/metadata.*plain object/);
  });

  it('rejects non-object metadata (e.g. string)', async () => {
    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate(
      { subject: 'X', metadata: 'foo' } as Record<string, unknown>,
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
  });
});

describe('todo_create extension hook gating', () => {
  let runtime: ReturnType<typeof createExtensionRuntime> | null = null;

  beforeEach(() => {
    runtime = null;
  });

  afterEach(async () => {
    const active = getActiveExtensionRuntime();
    if (active) {
      await active.dispose();
    }
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });

  it('exposes requested initial state to the gate and emits only the admitted final state', async () => {
    runtime = createExtensionRuntime().activate();
    const received: string[] = [];
    runtime.on('todo:created', event => { received.push(event.item.status); });
    runtime.registerHook('todo:before-create', ({ seed }) => {
      if (seed.status === 'in_progress' && seed.subject === 'Blocked') return 'not authorized';
    });
    const { ctx, store } = makeContextWithStore();
    expect(JSON.parse(await toolTodoCreate({ subject: 'Blocked', status: 'in_progress' }, ctx))).toEqual({ ok: false, code: 'todo_hook_veto', reason: 'not authorized' });
    expect(store.hasItems()).toBe(false);
    expect(received).toEqual([]);
    expect(JSON.parse(await toolTodoCreate({ subject: 'Allowed', status: 'in_progress' }, ctx))).toEqual({ ok: true, id: 'todo_1' });
    expect(received).toEqual(['in_progress']);
  });

  it('returns {ok:false} with the hook-supplied string reason when hook blocks via string', async () => {
    runtime = createExtensionRuntime().activate();
    // registerHook() is the programmatic equivalent of an extension
    // subscribing to 'todo:before-create' via api.hook(...).
    runtime.registerHook('todo:before-create', (hookCtx) => {
      if (String(hookCtx.seed.subject).startsWith('forbidden')) {
        return 'policy: content starts with forbidden';
      }
    });

    const { ctx } = makeContextWithStore();
    const blocked = await toolTodoCreate({ subject: 'forbidden thing' }, ctx);
    const blockedParsed = JSON.parse(blocked) as { ok: boolean; reason: string };
    expect(blockedParsed.ok).toBe(false);
    expect(blockedParsed.reason).toBe('policy: content starts with forbidden');

    // Allowed content should still pass through.
    const ok = await toolTodoCreate({ subject: 'safe step' }, ctx);
    const okParsed = JSON.parse(ok) as { ok: boolean };
    expect(okParsed.ok).toBe(true);
  });

  it('returns {ok:false, reason:"blocked-by-hook"} when hook returns false', async () => {
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-create', () => false);

    const { ctx, store } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: 'X' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('blocked-by-hook');
    // Hook ran BEFORE store.add — no item should have been allocated.
    expect(store.hasItems()).toBe(false);
  });

  it('allows the create when no hook is registered (default path)', async () => {
    const { ctx, store } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: 'X' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean; id?: string };
    expect(parsed.ok).toBe(true);
    expect(store.hasItems()).toBe(true);
  });

  it("fires 'todo:created' event with {id, item, source:'tool'} after store.add succeeds", async () => {
    runtime = createExtensionRuntime().activate();
    const received: Array<{ id: string; source: string; itemContent: string }> = [];
    runtime.on('todo:created', (payload) => {
      received.push({
        id: payload.id,
        source: payload.source,
        itemContent: payload.item.subject,
      });
    });

    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate(
      { subject: 'Test event payload' },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean; id: string };
    expect(parsed.ok).toBe(true);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: parsed.id,
      source: 'tool',
      itemContent: 'Test event payload',
    });
  });

  it("does NOT fire 'todo:created' when a hook blocks the create", async () => {
    runtime = createExtensionRuntime().activate();
    runtime.registerHook('todo:before-create', () => 'blocked-by-policy');
    let eventCount = 0;
    runtime.on('todo:created', () => {
      eventCount++;
    });

    const { ctx } = makeContextWithStore();
    const out = await toolTodoCreate({ subject: 'X' }, ctx);
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(eventCount).toBe(0);
  });
});
