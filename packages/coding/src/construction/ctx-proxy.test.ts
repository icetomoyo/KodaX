/**
 * CtxProxy unit tests.
 *
 * Per DD §14.5.3 the proxy dispatches `ctx.tools.<name>(...)` through
 * `executeTool()` so constructed handlers reuse the SAME pipeline as
 * builtin invocations. Tests therefore register mock tools into
 * TOOL_REGISTRY (the real path) rather than synthesizing a
 * `ctx.tools` map on the host context — that earlier shape was the
 * implementation bug DD §14.5.3 explicitly rules out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCtxProxy } from './ctx-proxy.js';
import { CapabilityDeniedError } from './types.js';
import { registerTool } from '../tools/registry.js';
import type { KodaXToolExecutionContext } from '../types.js';

const ctx = { backups: new Map() } as KodaXToolExecutionContext;

describe('createCtxProxy', () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    for (const u of unregisters.splice(0)) u();
  });

  function registerMock(
    name: string,
    handler: (input: Record<string, unknown>, ctx: KodaXToolExecutionContext) => Promise<string>,
  ) {
    const unregister = registerTool(
      {
        name,
        description: `mock ${name}`,
        input_schema: { type: 'object', properties: {} },
        handler,
        toClassifierInput: () => '',
      },
      { source: { kind: 'extension', id: `mock:${name}`, label: name } },
    );
    unregisters.push(unregister);
  }

  it('exposes whitelisted tool names and dispatches through executeTool', async () => {
    const realRead = vi.fn(async (input: Record<string, unknown>) => `content:${input.path}`);
    registerMock('mock-read', realRead);

    const proxied = createCtxProxy({ ...ctx, executionCwd: '/tmp' }, { tools: ['mock-read'] }) as {
      tools: { 'mock-read': (input: { path: string }) => Promise<string> };
      executionCwd: string;
    };

    const result = await proxied.tools['mock-read']({ path: '/etc/hosts' });
    expect(result).toBe('content:/etc/hosts');
    expect(realRead).toHaveBeenCalledWith({ path: '/etc/hosts' }, expect.any(Object));
    expect(proxied.executionCwd).toBe('/tmp');
  });

  it('throws CapabilityDeniedError when handler accesses an undeclared tool', () => {
    const proxied = createCtxProxy(ctx, { tools: ['mock-read'] }) as {
      tools: Record<string, unknown>;
    };

    expect(() => proxied.tools['mock-bash']).toThrow(CapabilityDeniedError);
  });

  it('reports denied tool name and declared whitelist on the error', () => {
    const proxied = createCtxProxy(ctx, { tools: ['grep'] }) as {
      tools: Record<string, unknown>;
    };

    try {
      void proxied.tools.read;
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError);
      const denied = err as CapabilityDeniedError;
      expect(denied.toolName).toBe('read');
      expect(denied.declaredTools).toEqual(['grep']);
    }
  });

  it('invokes onDenied callback before throwing', () => {
    const onDenied = vi.fn();
    const proxied = createCtxProxy(ctx, { tools: ['grep'] }, { onDenied }) as {
      tools: Record<string, unknown>;
    };

    expect(() => proxied.tools.unknown).toThrow(CapabilityDeniedError);
    expect(onDenied).toHaveBeenCalledWith({
      toolName: 'unknown',
      declaredTools: ['grep'],
    });
  });

  it('refuses to mutate or delete the tools proxy', () => {
    registerMock('mock-touch', async () => 'ok');
    const proxied = createCtxProxy(ctx, { tools: ['mock-touch'] }) as {
      tools: Record<string, unknown>;
    };

    expect(() => {
      (proxied.tools as Record<string, unknown>)['mock-touch'] = vi.fn();
    }).toThrow(/mutate ctx\.tools/);
    expect(() => {
      delete (proxied.tools as Record<string, unknown>)['mock-touch'];
    }).toThrow(/delete ctx\.tools/);
  });

  it('returns null prototype for the tools proxy (no prototype pollution surface)', () => {
    const proxied = createCtxProxy(ctx, { tools: [] }) as { tools: object };
    expect(Object.getPrototypeOf(proxied.tools)).toBeNull();
  });

  it('passes through non-tools ctx fields unchanged', () => {
    const askUser = vi.fn();
    const hostCtx = {
      ...ctx,
      executionCwd: '/work',
      gitRoot: '/work/repo',
      askUser,
    } as KodaXToolExecutionContext;

    const proxied = createCtxProxy(hostCtx, { tools: [] }) as KodaXToolExecutionContext;

    expect(proxied.executionCwd).toBe('/work');
    expect(proxied.gitRoot).toBe('/work/repo');
    expect(proxied.askUser).toBe(askUser);
    expect(proxied.backups).toBe(hostCtx.backups);
  });

  it('whitelisting an unknown tool name surfaces executeTool unknown-tool error', async () => {
    // No tool registered for 'truly-nonexistent-name'. CtxProxy lets the
    // call reach executeTool, which returns a clear "Unknown tool" error
    // string — no silent stub anymore.
    const proxied = createCtxProxy(ctx, { tools: ['truly-nonexistent-name'] }) as {
      tools: { 'truly-nonexistent-name': (input: unknown) => Promise<string> };
    };

    const out = await proxied.tools['truly-nonexistent-name']({});
    expect(out).toContain('Unknown tool');
    expect(out).toContain('truly-nonexistent-name');
  });

  it('handles missing host ctx (undefined) without crashing', () => {
    const proxied = createCtxProxy(undefined, { tools: [] }) as {
      tools: Record<string, unknown>;
    };
    expect(proxied.tools).toBeDefined();
  });

  it('freezes top-level proxy so handlers cannot reassign ctx.tools', () => {
    const proxied = createCtxProxy(ctx, { tools: [] }) as { tools: Record<string, unknown> };

    expect(() => {
      (proxied as { tools: unknown }).tools = { evil: vi.fn() };
    }).toThrow();
  });

  it('forwards a mutable ctx with shared references (Map/AbortSignal pass through)', async () => {
    let observedCtx: KodaXToolExecutionContext | undefined;
    registerMock('mock-inspect-ctx', async (_input, capturedCtx) => {
      observedCtx = capturedCtx;
      return 'ok';
    });

    const hostCtx = { ...ctx, executionCwd: '/host' } as KodaXToolExecutionContext;
    const proxied = createCtxProxy(hostCtx, { tools: ['mock-inspect-ctx'] }) as {
      tools: { 'mock-inspect-ctx': (input: unknown) => Promise<string> };
    };

    await proxied.tools['mock-inspect-ctx']({});
    // The dispatched builtin observes a *fresh* ctx (so depth tracking
    // can be threaded), but every reference field — backups Map,
    // executionCwd, etc. — must point at the same instance the host
    // owns, and the ctx must NOT be frozen (builtins like `read` write
    // into ctx.backups).
    expect(observedCtx).not.toBe(hostCtx);
    expect(Object.isFrozen(observedCtx)).toBe(false);
    expect(observedCtx?.backups).toBe(hostCtx.backups);
    expect(observedCtx?.executionCwd).toBe('/host');
  });

  it('honors hostCtx.planModeBlockCheck for ctx.tools.<name> calls', async () => {
    // Plan-mode propagation: a constructed handler must not be able to
    // bypass the parent's plan-mode gate by routing builtin invocations
    // through ctx.tools.bash. The predicate closes over live parent
    // state, so toggles propagate.
    const handler = vi.fn(async () => 'should-not-run');
    registerMock('mock-write', handler);
    const planModeBlockCheck = vi.fn((tool: string, _input: Record<string, unknown>) =>
      tool === 'mock-write' ? 'Write blocked in plan mode.' : null,
    );
    const hostCtx = { ...ctx, planModeBlockCheck } as KodaXToolExecutionContext;
    const proxied = createCtxProxy(hostCtx, { tools: ['mock-write'] }) as {
      tools: { 'mock-write': (input: unknown) => Promise<string> };
    };

    const out = await proxied.tools['mock-write']({ path: '/work/x.ts', content: 'evil' });
    expect(out).toMatch(/plan-mode applies transitively/);
    expect(out).toMatch(/Write blocked/);
    expect(handler).not.toHaveBeenCalled();
    expect(planModeBlockCheck).toHaveBeenCalledWith(
      'mock-write',
      { path: '/work/x.ts', content: 'evil' },
    );
  });

  it('lets the call through when planModeBlockCheck returns null', async () => {
    const handler = vi.fn(async () => 'ok');
    registerMock('mock-readonly', handler);
    const planModeBlockCheck = vi.fn(() => null);
    const hostCtx = { ...ctx, planModeBlockCheck } as KodaXToolExecutionContext;
    const proxied = createCtxProxy(hostCtx, { tools: ['mock-readonly'] }) as {
      tools: { 'mock-readonly': (input: unknown) => Promise<string> };
    };

    expect(await proxied.tools['mock-readonly']({})).toBe('ok');
    expect(handler).toHaveBeenCalled();
  });

  it('caps constructed→constructed call depth at MAX_CONSTRUCTED_DEPTH', async () => {
    // Register a faux "constructed" mock by forcing source.kind='constructed'.
    // Each call recurses into ctx.tools.<self> with the proxy that load-handler
    // would have built — so we mirror that here by constructing a fresh proxy
    // per invocation, threading the same hostCtx (which carries the depth).
    let invocations = 0;
    const constructedHandler: import('../tools/types.js').ToolHandlerSync = async (_input, capturedCtx) => {
      invocations += 1;
      if (invocations > 50) return 'runaway-guard';
      const childProxy = createCtxProxy(capturedCtx, { tools: ['recursive'] }) as {
        tools: { recursive: (input: unknown) => Promise<string> };
      };
      return childProxy.tools.recursive({});
    };
    const unregister = registerTool(
      {
        name: 'recursive',
        description: 'recurses',
        input_schema: { type: 'object', properties: {} },
        handler: constructedHandler,
        toClassifierInput: () => '',
      },
      { source: { kind: 'constructed', id: 'mock:recursive', label: 'recursive', version: '1.0.0' } },
    );
    unregisters.push(unregister);

    const proxied = createCtxProxy(ctx, { tools: ['recursive'] }) as {
      tools: { recursive: (input: unknown) => Promise<string> };
    };
    const out = await proxied.tools.recursive({});
    expect(out).toMatch(/depth limit/);
    // Outer call (depth 0→1) + 5 nested before the gate fires = 6 invocations.
    expect(invocations).toBeLessThanOrEqual(6);
  });

  it('does NOT count constructed→builtin transitions toward the depth limit', async () => {
    // A constructed tool calling a builtin tool many times should never
    // hit the depth gate (only constructed→constructed transitions do).
    let builtinCalls = 0;
    registerMock('cheap-builtin', async () => {
      builtinCalls += 1;
      return 'b';
    });

    const proxied = createCtxProxy(ctx, { tools: ['cheap-builtin'] }) as {
      tools: { 'cheap-builtin': (input: unknown) => Promise<string> };
    };
    for (let i = 0; i < 20; i += 1) {
      await proxied.tools['cheap-builtin']({});
    }
    expect(builtinCalls).toBe(20);
  });
});
