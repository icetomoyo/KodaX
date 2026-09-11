import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  disposeLoadedHandler,
  loadHandler,
  shutdownConstructedHandlerWorkersForTest,
} from './load-handler.js';
import { CapabilityDeniedError } from './types.js';
import type { ScriptSource } from './types.js';
import { registerTool } from '../tools/registry.js';
import type { KodaXToolExecutionContext } from '../types.js';

let tmpRoot: string;
const unregisters: Array<() => void> = [];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-loadhandler-'));
});

afterEach(async () => {
  for (const u of unregisters.splice(0)) u();
  await shutdownConstructedHandlerWorkersForTest();
  await fs.rm(tmpRoot, { recursive: true, force: true });
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

function jsSource(code: string): ScriptSource {
  return { kind: 'script', language: 'javascript', code };
}

describe('loadHandler', () => {
  it('rejects non-javascript languages (v0.7.28 limit)', async () => {
    const tsSource = {
      kind: 'script',
      language: 'typescript' as never,
      code: 'export async function handler() { return "x"; }',
    } as ScriptSource;

    await expect(
      loadHandler(
        { name: 't', version: '1.0.0', cwd: tmpRoot },
        tsSource,
        { tools: [] },
      ),
    ).rejects.toThrow(/must be \{ kind: 'script', language: 'javascript' \}/);
  });

  it('writes the handler module to the constructed tools subpath', async () => {
    const code = `export async function handler(input) { return JSON.stringify(input); }`;
    await loadHandler(
      { name: 'echo', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
    );

    const filePath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'echo', '1.0.0.mjs');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(code);
  });

  it('imports the module and invokes its handler with input + ctx', async () => {
    const code = `
      export async function handler(input, ctx) {
        return 'echo:' + input.value;
      }
    `;
    const handler = await loadHandler(
      { name: 'echo-runner', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
    );

    const result = await handler({ value: 'hi' }, {
      backups: new Map(),
      executionCwd: tmpRoot,
    });
    expect(result).toBe('echo:hi');
  });

  it('JSON.stringifies non-string return values for ToolHandlerSync compatibility', async () => {
    const code = `export async function handler() { return { ok: true, n: 42 }; }`;
    const handler = await loadHandler(
      { name: 'obj-result', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
    );

    const result = await handler({}, { backups: new Map() });
    if (typeof result !== 'string') throw new Error('Plain objects must remain JSON text.');
    expect(JSON.parse(result)).toEqual({ ok: true, n: 42 });
  });

  it.each([42, true, null, [], [1, 2], [{ type: 'image', path: 42 }]])(
    'keeps ordinary JSON return values compatible: %j', async (value) => {
      const handler = await loadHandler(
        { name: 'json-result', version: '1.0.0', cwd: tmpRoot },
        jsSource(`export async function handler() { return ${JSON.stringify(value)}; }`),
        { tools: [] },
      );
      expect(await handler({}, { backups: new Map() })).toBe(JSON.stringify(value));
    },
  );

  it('retains host gate error codes across both Worker RPC directions', async () => {
    const handler = await loadHandler(
      { name: 'forward-error', version: '1.0.0', cwd: tmpRoot },
      jsSource('export async function handler(input, ctx) { return await ctx.tools.read(input); }'),
      { tools: ['read'] },
    );
    await expect(handler({}, { backups: new Map(), planModeBlockCheck: () => {
      throw Object.assign(new TypeError('host error'), { code: 'ERR_INVALID_ARG_TYPE' });
    } })).rejects.toMatchObject({
      name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', message: 'host error',
    });
  });

  it('throws when the module does not export `handler` as a function', async () => {
    const code = `export const handler = 42;`;
    await expect(
      loadHandler(
        { name: 'bad-export', version: '1.0.0', cwd: tmpRoot },
        jsSource(code),
        { tools: [] },
      ),
    ).rejects.toThrow(/did not export 'handler' as a function/);
  });

  it('catches synchronous throws inside the handler (no escaping the race)', async () => {
    const code = `export function handler() { throw new Error('boom'); }`;
    const handler = await loadHandler(
      { name: 'sync-throw', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
    );

    await expect(handler({}, { backups: new Map() })).rejects.toThrow(/boom/);
  });

  it('hard-terminates a CPU loop on timeout and respawns for the next invocation', async () => {
    const code = `
      export async function handler(input) {
        if (input.spin) while (true) {}
        return 'recovered';
      }
    `;
    const handler = await loadHandler(
      { name: 'slow', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
      { timeoutMs: 50 },
    );

    await expect(handler({ spin: true }, { backups: new Map() })).rejects.toThrow(/timed out after 50ms/);
    await expect(handler({}, { backups: new Map() })).resolves.toBe('recovered');
  });

  it('executes constructed code outside the host V8 isolate', async () => {
    const code = `
      import { isMainThread } from 'node:worker_threads';
      export async function handler() { return String(isMainThread); }
    `;
    const handler = await loadHandler(
      { name: 'worker-check', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
    );

    await expect(handler({}, { backups: new Map() })).resolves.toBe('false');
  });

  it('bridges the host abort signal into the handler Worker', async () => {
    const handler = await loadHandler(
      { name: 'abort-aware', version: '1.0.0', cwd: tmpRoot },
      jsSource(`export async function handler(_input, ctx) {
        if (ctx.abortSignal.aborted) return 'aborted';
        await new Promise((resolve) => ctx.abortSignal.addEventListener('abort', resolve, { once: true }));
        return 'aborted';
      }`),
      { tools: [] },
      { timeoutMs: 5_000 },
    );
    const controller = new AbortController();
    const result = handler({}, { backups: new Map(), abortSignal: controller.signal });
    controller.abort();

    await expect(result).resolves.toBe('aborted');
  });

  it('does not restart queued invocations after the handler is disposed', async () => {
    const scope = { name: 'dispose-queued', version: '1.0.0', cwd: tmpRoot };
    const handler = await loadHandler(
      scope,
      jsSource(`export async function handler(input) {
        if (input.wait) await new Promise((resolve) => setTimeout(resolve, 5_000));
        return 'should-not-run';
      }`),
      { tools: [] },
    );
    const first = handler({ wait: true }, { backups: new Map() });
    const queued = handler({}, { backups: new Map() });
    const firstExpectation = expect(first).rejects.toThrow(/disposed/i);
    const queuedExpectation = expect(queued).rejects.toThrow(/disposed/i);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await disposeLoadedHandler(scope);

    await firstExpectation;
    await queuedExpectation;
    await expect(handler({}, { backups: new Map() })).rejects.toThrow(/disposed/i);
  });

  it('integrates CtxProxy: handler can call whitelisted ctx.tools.<name> via executeTool', async () => {
    const readMock = vi.fn(async (input: Record<string, unknown>) => `data@${input.path}`);
    registerMock('lh-read', readMock);

    const code = `
      export async function handler(input, ctx) {
        const r = await ctx.tools['lh-read']({ path: input.path });
        return 'got:' + r;
      }
    `;
    const handler = await loadHandler(
      { name: 'with-tools', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: ['lh-read'] },
    );

    const result = await handler({ path: '/x' }, { backups: new Map() } as KodaXToolExecutionContext);
    expect(result).toBe('got:data@/x');
    expect(readMock).toHaveBeenCalledWith({ path: '/x' }, expect.any(Object));
  });

  it('integrates CtxProxy: handler accessing undeclared tool fails with CapabilityDeniedError', async () => {
    registerMock('lh-bash', async () => 'should-not-run');
    const code = `
      export async function handler(input, ctx) {
        return await ctx.tools['lh-bash']({ command: 'rm -rf /' });
      }
    `;
    const handler = await loadHandler(
      { name: 'denies-bash', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: ['read'] }, // lh-bash NOT declared
    );

    await expect(
      handler({}, { backups: new Map() } as KodaXToolExecutionContext),
    ).rejects.toThrow(CapabilityDeniedError);
  });
});
