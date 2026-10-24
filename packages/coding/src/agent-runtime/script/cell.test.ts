import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runScriptCell } from './cell.js';

const limits = { timeoutMs: 3_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };

it('evaluates isolated JavaScript and composes dependent calls in one cell', async () => {
  const invoke = vi.fn(async (name: string, input: Record<string, unknown>) => ({ content: name === 'read' ? 'one\ntwo' : String(input.value) }));
  const result = await runScriptCell({ code: 'const r = await tools.read({path:"x"}); return await tools.grep({value:r.content.split("\\n")[1]});',
    toolNames: ['read', 'grep'], limits, invoke });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual({ content: 'two' });
  expect(result.receipts.map(receipt => receipt.name)).toEqual(['read', 'grep']);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('has no host globals, Node modules or host Function constructor escape', async () => {
  const invoke = vi.fn();
  const result = await runScriptCell({ limits, toolNames: ['read'], invoke,
    code: `const imports = await import('node:fs').then(() => 'escaped', () => 'denied');
      return [typeof process, typeof require, typeof fetch, typeof Buffer, typeof WebAssembly,
        tools.read.constructor('return typeof process')(), imports];` });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'denied']);
  expect(invoke).not.toHaveBeenCalled();
});

it('denies hidden control/bridge calls even when the guest invokes the transport directly', async () => {
  const invoke = vi.fn();
  const result = await runScriptCell({ limits, toolNames: ['read'], invoke,
    code: `return await __hostCall('tool_call', JSON.stringify({name:'spawn_agent',input:{}}));` });
  expect(result.hadToolErrors).toBe(true);
  expect(result.receipts[0]?.result).toMatchObject({ isError: true });
  expect(invoke).not.toHaveBeenCalled();
});

it('bounds CPU and memory and leaves the next cell usable', async () => {
  const invoke = vi.fn();
  const cpu = await runScriptCell({ limits: { ...limits, timeoutMs: 1_000 }, toolNames: [], invoke, code: 'while(true) {}' });
  expect(['timed_out', 'failed']).toContain(cpu.status);
  const memory = await runScriptCell({ limits, toolNames: [], invoke, code: 'new ArrayBuffer(64 * 1024 * 1024); return "allocation succeeded";' });
  expect(memory.status).toBe('failed');
  expect(memory.error).toMatch(/memory/i);
  const next = await runScriptCell({ limits, toolNames: [], invoke, code: 'return 42;' });
  expect(next.value).toBe(42);
});

it('preserves confirmed effects after failure, and never automatically replays them on recovery', async () => {
  let writes = 0;
  const invoke = vi.fn(async () => ({ content: `write-${++writes}` }));
  const result = await runScriptCell({ limits, toolNames: ['edit'], invoke,
    code: 'await tools.edit({path:"x"}); throw new Error("test failed after edit");' });
  expect(result.status).toBe('failed');
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.result.content).toBe('write-1');
  const recovery = await runScriptCell({ limits, toolNames: ['edit'], invoke, code: 'return "Inspect prior receipt; no repeated edit";' });
  expect(recovery.status).toBe('completed');
  expect(writes).toBe(1);
});

it('cancels the guest, waits for admitted tool cleanup and prevents queued effects', async () => {
  const abort = new AbortController();
  const effects: string[] = [];
  let settled = false;
  const invoke = vi.fn(async (_name, _input, signal: AbortSignal) => {
    effects.push('started');
    signal.addEventListener('abort', () => effects.push('aborted'), { once: true });
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    settled = true;
    return { content: '[Tool Error] cancelled', isError: true };
  });
  const result = await runScriptCell({ limits, toolNames: ['read'], invoke, signal: abort.signal,
    code: 'await Promise.all([tools.read({path:"one"}), tools.read({path:"two"})]);' });
  expect(result.status).toBe('cancelled');
  expect(settled).toBe(true);
  expect(effects).toEqual(['started', 'aborted']);
  expect(invoke).toHaveBeenCalledOnce();
  expect(result.receipts).toHaveLength(1);
});

it('caps calls and transfer size rather than silently dropping errors or results', async () => {
  const invoke = vi.fn(async () => ({ content: 'ok' }));
  const called = await runScriptCell({ limits: { ...limits, maxCalls: 1 }, toolNames: ['read'], invoke,
    code: 'await tools.read({path:"one"}); await tools.read({path:"two"});' });
  expect(called.status).toBe('failed');
  expect(invoke).toHaveBeenCalledOnce();
  const oversized = await runScriptCell({ limits: { ...limits, maxTransferBytes: 128 }, toolNames: ['read'],
    invoke: async () => ({ content: 'x'.repeat(256) }), code: 'return await tools.read({});' });
  expect(oversized.status).toBe('failed');
  expect(oversized.error).toContain('transfer limit');
  expect(oversized.receipts[0]?.result.content).toHaveLength(256);
});

it('rejects non-DTO host results without losing the original receipt', async () => {
  const result = { content: 'ok', metadata: { lookup: new Map([['x', 42]]) } };
  const execution = await runScriptCell({ limits, toolNames: ['read'], invoke: async () => result,
    code: 'return await tools.read({});' });
  expect(execution.status).toBe('failed');
  expect(execution.error).toContain('JSON');
  expect(execution.receipts[0]?.result).toBe(result);
});

it('loads its worker through the project tsx source entry without inherited loader helpers', async () => {
  const code = `import {runScriptCell} from ${JSON.stringify(new URL('./cell.ts', import.meta.url).href)};
    const result = await runScriptCell({code:'return 42;',toolNames:[],limits:${JSON.stringify(limits)},invoke:async()=>({content:'ok'})});
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { windowsHide: true, timeout: 10_000 });
  expect(JSON.parse(stdout)).toMatchObject({ status: 'completed', value: 42, receipts: [] });
});

it('does not mistake unawaited tools or invalid JSON arguments for a successful cell', async () => {
  const result = await runScriptCell({ limits, toolNames: ['read'], invoke: async () => ({ content: 'ok' }),
    code: 'tools.read({}); return "already done";' });
  expect(result.status).toBe('failed');
  expect(result.error).toContain('unawaited');
  const invoke = vi.fn();
  const invalid = await runScriptCell({ limits, toolNames: ['read'], invoke,
    code: 'return await tools.read(["invalid"]);' });
  expect(invalid.hadToolErrors).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});

it('rejects invalid limits and oversized source before creating a worker', async () => {
  const input = { code: 'return 42;', toolNames: [], invoke: vi.fn(), limits };
  await expect(runScriptCell({ ...input, limits: { ...limits, maxCalls: 0 } })).rejects.toThrow('positive safe integers');
  await expect(runScriptCell({ ...input, limits: { ...limits, maxTransferBytes: 1 } })).rejects.toThrow('source exceeds');
});
