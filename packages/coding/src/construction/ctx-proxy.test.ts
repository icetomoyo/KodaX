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

  it('forwards the ORIGINAL host ctx (not the frozen proxy) to dispatched builtin', async () => {
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
    // The dispatched builtin must observe the unmodified host ctx —
    // not a frozen proxy that would prevent later mutation by builtins
    // like `read` (which writes into `ctx.backups`).
    expect(observedCtx).toBe(hostCtx);
  });
});
