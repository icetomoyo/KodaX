import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { loadHandler } from './load-handler.js';
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

    const filePath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'echo', '1.0.0.js');
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
    expect(JSON.parse(result)).toEqual({ ok: true, n: 42 });
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

  it('enforces timeout via Promise.race', async () => {
    const code = `
      export async function handler() {
        await new Promise((r) => setTimeout(r, 5000));
        return 'never';
      }
    `;
    const handler = await loadHandler(
      { name: 'slow', version: '1.0.0', cwd: tmpRoot },
      jsSource(code),
      { tools: [] },
      { timeoutMs: 50 },
    );

    await expect(handler({}, { backups: new Map() })).rejects.toThrow(/timed out after 50ms/);
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
