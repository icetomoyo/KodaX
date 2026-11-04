import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveScriptWorkerUrl, runScriptCell } from './cell.js';

const limits = { timeoutMs: 3_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };

it.each(['yield_control()', "text('')", "store('same', 1)"])(
  'bounds empty or repeated control messages before Host persistence (%s)', async operation => {
    let events = 0;
    const persisted = async () => { events++; await new Promise(resolve => setTimeout(resolve, 5)); };
    const result = await runScriptCell({ code: `for(let i=0;i<400;i++) ${operation}; return 42;`, toolNames: [],
      limits: { ...limits, timeoutMs: 1000, maxCalls: 1, maxTransferBytes: 1024 }, invoke: vi.fn(),
      onYield: persisted, onOutput: persisted, onStore: () => { events++; } });
    expect(events).toBeLessThanOrEqual(32);
    if (operation === 'yield_control()') { expect(events).toBe(1); expect(result.status).toBe('completed'); }
    else expect(result.status).toBe('failed');
  });

it('evaluates isolated JavaScript and composes dependent calls in one cell', async () => {
  const invoke = vi.fn(async (name: string, input: Record<string, unknown>) => ({ content: name === 'read' ? 'one\ntwo' : String(input.value) }));
  const result = await runScriptCell({ code: 'const r = await tools.read({path:"x"}); return await tools.grep({value:r.content.split("\\n")[1]});',
    toolNames: ['read', 'grep'], limits, invoke });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual({ content: 'two' });
  expect(result.receipts.map(receipt => receipt.name)).toEqual(['read', 'grep']);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('calls an authorized generic tool through the same bare alias and namespace function', async () => {
  const invoke = vi.fn(async (_name: string, input: Record<string, unknown>) => ({ content: String(input.value) }));
  const result = await runScriptCell({ limits, toolNames: ['lookup_record'], invoke,
    code: 'const first = await lookup_record({value:21}); const second = await tools.lookup_record({value:42}); return {same:lookup_record===tools.lookup_record,values:[first.content,second.content]};' });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual({ same: true, values: ['21', '42'] });
  expect(result.receipts.map(receipt => ({ id: receipt.id, name: receipt.name, input: receipt.input })))
    .toEqual([{ id: 1, name: 'lookup_record', input: { value: 21 } }, { id: 2, name: 'lookup_record', input: { value: 42 } }]);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('has no inherited callable namespace entries while preserving authorized prototype names', async () => {
  const invoke = vi.fn(async (name: string) => ({ content: name }));
  const result = await runScriptCell({ limits, toolNames: ['constructor', '__proto__'], invoke, code: `
    return { inherited: typeof tools.toString, prototype: Object.getPrototypeOf(tools), frozen: Object.isFrozen(tools),
      values: [(await tools['constructor']({})).content, (await tools['__proto__']({})).content] };
  ` });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual({ inherited: 'undefined', prototype: null, frozen: true, values: ['constructor', '__proto__'] });
  expect(result.receipts.map(receipt => receipt.name)).toEqual(['constructor', '__proto__']);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('keeps controls and JavaScript globals intact while exposing every authorized name through tools', async () => {
  const names = ['text', 'store', 'load', 'read_result', 'yield_control', 'tools', '__hostCall', '__store', '__load', '__emit',
    'Object', 'Promise', 'JSON', 'Function', 'constructor', '__proto__', 'toString', 'await', 'default', 'eval', 'arguments',
    'a-b', 'capability.inspect', '读取', '$lookup', '_lookup'];
  const invoke = vi.fn(async (name: string) => ({ content: name }));
  let yielded = 0;
  const result = await runScriptCell({ limits: { ...limits, maxCalls: names.length }, toolNames: names, invoke,
    onYield: () => { yielded++; }, code: `
      store('answer', 42); text(load('answer')); yield_control();
      const bare = [读取 === tools['读取'], $lookup === tools.$lookup, _lookup === tools._lookup];
      const protectedNames = ${JSON.stringify(names.slice(0, -3))}.every(name => globalThis[name] !== tools[name]);
      const results = [];
      for (const name of ${JSON.stringify(names)}) results.push((await tools[name]({})).content);
      return { bare, protectedNames, globals: [typeof Object, typeof Promise, typeof JSON.parse, typeof Function, typeof unlisted_tool], results };
    ` });
  expect(result.status, result.error).toBe('completed');
  expect(result.value).toEqual({ bare: [true, true, true], protectedNames: true,
    globals: ['function', 'function', 'function', 'function', 'undefined'], results: names });
  expect(result.outputs).toEqual(['42']);
  expect(yielded).toBe(1);
  expect(result.receipts.map(receipt => receipt.name)).toEqual(names);
  expect(invoke).toHaveBeenCalledTimes(names.length);
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

it.each(['tools.read', 'read'])('cancels %s, waits for admitted tool cleanup and prevents queued effects', async call => {
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
    code: `await Promise.all([${call}({path:"one"}), ${call}({path:"two"})]);` });
  expect(result.status).toBe('cancelled');
  expect(settled).toBe(true);
  expect(effects).toEqual(['started', 'aborted']);
  expect(invoke).toHaveBeenCalledOnce();
  expect(result.receipts).toHaveLength(1);
});

it.each(['tools.read', 'read'])('caps %s calls and transfer size rather than silently dropping errors or results', async call => {
  const invoke = vi.fn(async () => ({ content: 'ok' }));
  const called = await runScriptCell({ limits: { ...limits, maxCalls: 1 }, toolNames: ['read'], invoke,
    code: `await ${call}({path:"one"}); await ${call}({path:"two"});` });
  expect(called.status).toBe('failed');
  expect(invoke).toHaveBeenCalledOnce();
  const oversized = await runScriptCell({ limits: { ...limits, maxTransferBytes: 128 }, toolNames: ['read'],
    invoke: async () => ({ content: 'x'.repeat(256) }), code: `return await ${call}({});` });
  expect(oversized.status).toBe('failed');
  expect(oversized.error).toContain('transfer limit');
  expect(oversized.receipts[0]?.result.content).toHaveLength(256);
});

it('lets a cell page a durably settled large result and select data without losing warnings or invoking effects again', async () => {
  let durable = false;
  const result = { content: '界'.repeat(3000) + '\nWARNING: original source is incomplete', isError: true,
    metadata: { warning: 'keep this original warning', truncated: true, actualInput: { original: 'retained' } } };
  const invoke = vi.fn(async () => result);
  const cell = await runScriptCell({ limits: { ...limits, maxTransferBytes: 2048 }, toolNames: ['host_large'], invoke,
    onReceipt: async () => { durable = true; }, code: `
      const result = await tools.host_large({});
      let encoded = '', offset, pages = 0;
      do { const page = await read_result(result.result_ref.callId, offset); encoded += page.text; pages++; offset = page.nextOffset; } while (offset !== undefined);
      const original = JSON.parse(encoded);
      return { status: result.status, isError: result.isError, warning: original.metadata.warning, truncated: original.metadata.truncated, length: original.content.length, pages };
    ` });
  expect(durable).toBe(true);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toMatchObject({ status: 'settled', isError: true, warning: 'keep this original warning', truncated: true, length: result.content.length });
  expect((cell.value as { pages: number }).pages).toBeGreaterThan(1);
  expect(cell.receipts[0]?.result).toEqual(result);
  expect(invoke).toHaveBeenCalledOnce();
  const next = await runScriptCell({ limits, toolNames: [], invoke,
    code: 'return await read_result(1);' });
  expect(next.status).toBe('failed');
  expect(next.error).toContain('from this cell');
  expect(invoke).toHaveBeenCalledOnce();
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

it('resolves package, root, SDK chunk and executable sidecars according to their distribution layout', () => {
  const root = path.resolve('fixture-dist');
  const resolve = (relative: string) => fileURLToPath(resolveScriptWorkerUrl(pathToFileURL(path.join(root, relative)).href));
  vi.stubEnv('KODAX_BUNDLED', 'false');
  try {
    expect(resolve('agent-runtime/script/cell.js')).toBe(path.join(root, 'agent-runtime/script/worker.js'));
    expect(resolve('script-cell.mjs')).toBe(path.join(root, 'script-worker.cjs'));
    expect(resolve('chunks/sdk-chunk.js')).toBe(path.join(root, 'script-worker.cjs'));
    vi.stubEnv('KODAX_BUNDLED', 'true');
    expect(resolve('embedded-entry.js')).toBe(path.join(path.dirname(process.execPath), 'script-worker.cjs'));
  } finally { vi.unstubAllEnvs(); }
});
