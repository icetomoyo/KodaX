import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import type { KodaXManagedWorkBudget, KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { executeTool, getToolDefinition, registerTool } from '../packages/coding/src/tools/index.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import { createExtensionRuntime, withExtensionRuntimeContext } from '../packages/coding/src/extensions/runtime.js';

const limits = { timeoutMs: 10_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 12, maxTransferBytes: 128 * 1024 };
const activeTools = ['read', 'grep', 'glob', 'edit', 'bash', 'spawn_agent', 'tool_call'];

it('reuses real dispatch for read/edit/test, retains refusal evidence and charges only executed leaves', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-pilot-'));
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: directory };
  const budget: KodaXManagedWorkBudget = { totalBudget: 3, spentBudget: 0, currentHarness: 'H0_DIRECT' };
  let denied = false;
  const before = vi.fn(async () => ({ action: 'allow' as const }));
  const after = vi.fn(async () => ({ action: 'allow' as const }));
  try {
    await writeFile(path.join(directory, 'value.mjs'), 'export const value = 1;\n');
    await writeFile(path.join(directory, 'fixture.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('two',()=>assert.equal(value,2));\n");
    const pilot = createScriptPilot({ ctx, activeToolNames: activeTools, runtimeSessionState: buildRuntimeSessionState({ activeTools, modelSelection: {} }),
      events: { beforeToolExecute: async (name, input) => {
        if (name === 'edit' && !denied) { denied = true; return '[Tool Error] Fixture permission denied once'; }
        if (name === 'bash') return input.command === 'node --test fixture.test.mjs' ? true : '[Tool Error] Command outside fixture';
        return input.path === 'value.mjs' ? true : '[Tool Error] Path outside fixture';
      } },
      toolGuardrails: [{ kind: 'tool', name: 'fixture', beforeTool: before, afterTool: after }],
      guardrailContext: { agent: { name: 'fixture', instructions: '' }, messages: [] },
    }, budget);
    expect(pilot.tools.map(tool => tool.name)).toEqual(['read', 'grep', 'glob', 'edit', 'bash']);
    const result = await pilot.run(`
      await tools.read({path:'value.mjs'});
      const input = {path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 2'}]};
      const denied = await tools.edit(input);
      if (!denied.isError) throw new Error('Expected test refusal');
      const edited = await tools.edit(input);
      if (edited.isError) throw new Error(edited.content);
      return await tools.bash({command:'node --test fixture.test.mjs'});
    `, limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.receipts.map(receipt => receipt.result.isError === true)).toEqual([false, true, false, false]);
    expect(result.hadToolErrors).toBe(true);
    expect(String(result.receipts[3]?.result.content)).toMatch(/pass\s+1/i);
    expect(await readFile(path.join(directory, 'value.mjs'), 'utf8')).toBe('export const value = 2;\n');
    expect(budget.spentBudget).toBe(3);
    expect(before).toHaveBeenCalledTimes(4);
    expect(after).toHaveBeenCalledTimes(4);
    const exhausted = await pilot.run("return await tools.read({path:'value.mjs'});", limits);
    expect(exhausted.hadToolErrors).toBe(true);
    expect(exhausted.receipts[0]?.result.content).toContain('budget');
    expect(budget.spentBudget).toBe(3);
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-script-pilot-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-script-pilot-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
async function fixture(totalBudget = 4) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-pilot-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'value.mjs'), 'export const value = 1;\n');
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: directory };
  const budget: KodaXManagedWorkBudget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' };
  const dispatch = { ctx, activeToolNames: [...activeTools], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools, modelSelection: {} }) };
  return { directory, ctx, budget, dispatch };
}

it.each([2, 4])('matches native leaf accounting with a %i-unit budget and stops without double charging', async total => {
  const { ctx, budget, dispatch } = await fixture(total);
  const nativeBudget = { ...budget };
  const native = wrapCodingToolAsRunnable(getToolDefinition('read')!, (input, context) => executeTool('read', input, context), ctx, nativeBudget);
  for (let i = 0; i < total; i++) expect((await native.execute({ path: 'value.mjs' }, { agent: { name: 'fixture', instructions: '' } })).isError).not.toBe(true);
  const result = await createScriptPilot(dispatch, budget).run(`for(let i=0;i<${total + 1};i++) await tools.read({path:'value.mjs'});`, limits);
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
});

it('honors explicit inventory, excluded tools and live revocation, without admitting control tools', async () => {
  const { ctx, budget, dispatch } = await fixture();
  const pilot = createScriptPilot({ ...dispatch, ctx: { ...ctx, excludeTools: ['edit'] } }, budget);
  expect(pilot.tools.map(tool => tool.name)).not.toContain('edit');
  expect(createScriptPilot({ ...dispatch, activeToolNames: undefined }, budget).tools).toEqual([]);
  dispatch.activeToolNames.splice(dispatch.activeToolNames.indexOf('read'), 1);
  const result = await pilot.run("return await tools.read({path:'value.mjs'});", limits);
  expect(result.hadToolErrors).toBe(true);
  expect(budget.spentBudget).toBe(0);
});

it('rejects same-name extension replacement after assembly', async () => {
  const { budget, dispatch } = await fixture();
  const pilot = createScriptPilot(dispatch, budget);
  const handler = vi.fn(async () => 'unexpected');
  const dispose = registerTool({ ...getToolDefinition('read')!, handler, sideEffect: 'readonly', toClassifierInput: () => '' }, { source: { kind: 'extension' } });
  try {
    const result = await pilot.run("return await tools.read({path:'value.mjs'});", limits);
    expect(result.hadToolErrors, JSON.stringify(result.receipts)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(budget.spentBudget).toBe(0);
  } finally { dispose(); }
});

it('retains canonical guardrail rewrites and denies rewrites into native control tools', async () => {
  const { budget, dispatch } = await fixture();
  let control = false;
  const pilot = createScriptPilot({ ...dispatch,
    guardrailContext: { agent: { name: 'fixture', instructions: '' } },
    toolGuardrails: [{ kind: 'tool', name: 'rewrite', beforeTool: async call => ({ action: 'rewrite',
      payload: { ...call, name: control ? 'spawn_agent' : 'read', input: { path: 'value.mjs' } } }) }],
  }, budget);
  const read = await pilot.run("return await tools.read({path:'wrong.mjs'});", limits);
  expect(read.receipts[0]?.result.metadata?.toolCall).toMatchObject({ name: 'read', input: { path: 'value.mjs' } });
  expect(read.hadToolErrors).toBe(false);
  control = true;
  const blocked = await pilot.run("return await tools.read({path:'value.mjs'});", limits);
  expect(blocked.hadToolErrors).toBe(true);
  expect(budget.spentBudget).toBe(1);
});

it('preserves existing edit recovery state and clears it only after a successful repair', async () => {
  const { directory, budget, dispatch } = await fixture();
  const pilot = createScriptPilot(dispatch, budget);
  const failed = await pilot.run("return await tools.edit({path:'value.mjs',edits:[{old_string:'absent',new_string:'two'}]});", limits);
  expect(failed.hadToolErrors).toBe(true);
  expect(failed.receipts[0]?.result.metadata?.editRecoveryMessages).toEqual([expect.stringContaining('unique old_string')]);
  expect(dispatch.runtimeSessionState.blockedEditWrites.has(path.join(directory, 'value.mjs'))).toBe(true);
  const repaired = await pilot.run("return await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 2'}]});", limits);
  expect(repaired.hadToolErrors).toBe(false);
  expect(dispatch.runtimeSessionState.blockedEditWrites.size).toBe(0);
  expect(budget.spentBudget).toBe(2);
});

it('honors both host cancellation signals before starting a cell', async () => {
  const { ctx, budget, dispatch } = await fixture();
  const contextAbort = new AbortController(); contextAbort.abort();
  const result = await createScriptPilot({ ...dispatch, abortSignal: new AbortController().signal,
    ctx: { ...ctx, abortSignal: contextAbort.signal } }, budget).run("return await tools.read({path:'value.mjs'});", limits);
  expect(result.status).toBe('cancelled');
  expect(result.receipts).toEqual([]);
  expect(budget.spentBudget).toBe(0);
});

it('retains a committed edit when a real test fails and can retry just the test', async () => {
  const { directory, budget, dispatch } = await fixture();
  await writeFile(path.join(directory, 'fixture.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('deliberate failure',()=>assert.equal(value,3));\n");
  const pilot = createScriptPilot(dispatch, budget);
  const first = await pilot.run(`
    await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 2'}]});
    const result = await tools.bash({command:'node --test fixture.test.mjs'});
    if (/fail\\s+1/i.test(result.content)) throw new Error('test failed after committed edit');
    throw new Error('fixture did not execute its failing test');
  `, limits);
  expect(first.status).toBe('failed');
  expect(first.error).toContain('test failed after committed edit');
  expect(first.receipts.map(receipt => receipt.name)).toEqual(['edit', 'bash']);
  expect(String(first.receipts[1]?.result.content)).toMatch(/fail\s+1/i);
  const retry = await pilot.run("return await tools.bash({command:'node --test fixture.test.mjs'});", limits);
  expect(retry.receipts.map(receipt => receipt.name)).toEqual(['bash']);
  expect(String(retry.receipts[0]?.result.content)).toMatch(/fail\s+1/i);
  expect(await readFile(path.join(directory, 'value.mjs'), 'utf8')).toBe('export const value = 2;\n');
  expect(budget.spentBudget).toBe(3);
}, 30_000);

it('settles real shell cancellation before returning and does not run queued edits', async () => {
  const { directory, budget, dispatch } = await fixture();
  await writeFile(path.join(directory, 'wait.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('started.txt',String(process.pid)); setInterval(()=>{},1000);\n");
  const abort = new AbortController();
  const pilot = createScriptPilot({ ...dispatch, abortSignal: abort.signal }, budget);
  const execution = pilot.run(`await tools.bash({command:'node wait.mjs'}); await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 9'}]});`,
    { ...limits, timeoutMs: 15_000 });
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && pid === undefined) {
      try { pid = Number(await readFile(path.join(directory, 'started.txt'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (pid === undefined) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(pid).toBeGreaterThan(0);
    abort.abort();
    const result = await execution;
    expect(result.status).toBe('cancelled');
    expect(result.receipts.map(receipt => receipt.name)).toEqual(['bash']);
    // Preserve the native shell envelope (Command first, then Cancelled); cell status is authoritative.
    expect(String(result.receipts[0]?.result.content)).toContain('[Cancelled]');
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(await readFile(path.join(directory, 'value.mjs'), 'utf8')).toBe('export const value = 1;\n');
    expect(budget.spentBudget).toBe(1);
  } finally {
    abort.abort(); await execution;
    if (pid !== undefined) {
      try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
}, 30_000);

it('retains trusted recovery artifact metadata for large native shell output', async () => {
  const { directory, budget, dispatch } = await fixture();
  vi.stubEnv('KODAX_TOOL_OUTPUT_DIR', path.join(directory, 'artifacts'));
  await writeFile(path.join(directory, 'output.mjs'), "process.stdout.write('x'.repeat(50_000));\n");
  const recorded = vi.fn();
  const result = await createScriptPilot({ ...dispatch, ctx: { ...dispatch.ctx, recordToolResultArtifact: recorded } }, budget)
    .run("return await tools.bash({command:'node output.mjs'});", limits);
  expect(result.status).toBe('completed');
  expect(recorded).toHaveBeenCalled();
  expect(result.receipts[0]?.result.metadata).toMatchObject({ truncated: true, capacityFallback: true,
    outputPath: recorded.mock.calls[0]?.[1] });
  expect(String(result.receipts[0]?.result.content)).toContain('KODAX_RESULT_INCOMPLETE');
}, 30_000);

it('keeps host extensions bound but prevents Script failures from falling back to unqualified MCP tools', async () => {
  const { ctx, budget, dispatch } = await fixture();
  const remote = vi.fn(async () => ({ kind: 'tool' as const, content: 'remote result' }));
  const extensionRuntime: NonNullable<KodaXToolExecutionContext['extensionRuntime']> = {
    searchCapabilities: async () => [{ id: 'mcp:read', name: 'read' }], executeCapability: remote,
    describeCapability: async () => undefined, readCapability: remote,
    getCapabilityPrompt: async () => undefined, getCapabilityPromptContext: async () => undefined,
  };
  ctx.extensionRuntime = extensionRuntime;
  const native = await runToolDispatch({ ...dispatch, abortSignal: undefined,
    toolBlocks: [{ type: 'tool_use', id: 'native-read', name: 'read', input: { path: 'missing.mjs' } }] });
  expect(native.get('native-read')).toContain('MCP Fallback');
  expect(remote).toHaveBeenCalledOnce();
  remote.mockClear();
  const pilot = createScriptPilot(dispatch, budget);
  const result = await pilot.run("return await tools.read({path:'missing.mjs'});", limits);
  expect(result.hadToolErrors).toBe(true);
  expect(result.receipts[0]?.result.content).not.toContain('MCP Fallback');
  expect(remote).not.toHaveBeenCalled();
  expect(budget.spentBudget).toBe(1);
  expect(ctx.extensionRuntime).toBe(extensionRuntime);
  const recovered = await pilot.run("return await tools.read({path:'value.mjs'});", limits);
  expect(recovered.hadToolErrors).toBe(false);
  expect(budget.spentBudget).toBe(2);
  const bridge = await runToolDispatch({ ...dispatch, abortSignal: undefined, allowMcpFallback: false,
    toolBlocks: [{ type: 'tool_use', id: 'bridge-read', name: 'tool_call', input: { name: 'read', input: { path: 'missing.mjs' } } }] });
  expect(bridge.get('bridge-read')).not.toContain('MCP Fallback');
  expect(remote).not.toHaveBeenCalled();
});

it('joins the real extension host event frame without changing its read-only permission policy', async () => {
  const { directory, ctx, budget, dispatch } = await fixture();
  const runtime = createExtensionRuntime();
  const starts: string[] = [];
  const results: string[] = [];
  runtime.on('tool:start', event => { starts.push(event.name); });
  runtime.on('tool:result', event => { results.push(event.name); });
  ctx.extensionRuntime = runtime;
  ctx.sessionId = 'script-host-session'; ctx.runtimeRunId = 'script-host-run';
  const permission = vi.fn(async (name: string) => name === 'read' ? true : '[Tool Error] Host is read-only');
  try {
    const result = await withExtensionRuntimeContext(() => createScriptPilot({ ...dispatch,
      events: { beforeToolExecute: permission } }, budget).run(`
        await tools.read({path:'value.mjs'});
        await tools.edit({path:'value.mjs',edits:[{old_string:'value = 1',new_string:'value = 9'}]});
        return await tools.read({path:'value.mjs'});
      `, limits), runtime, ctx.runtimeRunId);
    expect(result.status, result.error).toBe('completed');
    expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([false, true, false]);
    expect(starts).toEqual(['read', 'edit', 'read']);
    expect(results).toEqual(starts);
    expect(permission).toHaveBeenCalledTimes(3);
    expect(budget.spentBudget).toBe(2);
    expect(ctx.extensionRuntime).toBe(runtime);
    expect(await readFile(path.join(directory, 'value.mjs'), 'utf8')).toBe('export const value = 1;\n');
  } finally { await runtime.dispose(); }
});

it('rejects background shell calls before permission/execution until async lifecycle is qualified', async () => {
  const { budget, dispatch } = await fixture();
  const permission = vi.fn(async () => '[Tool Error] Fixture prevents a background process');
  const pilot = createScriptPilot({ ...dispatch, events: { beforeToolExecute: permission } }, budget);
  const result = await pilot.run("return await tools.bash({command:'node --version',run_in_background:true});", limits);
  expect(result.hadToolErrors).toBe(true);
  expect(result.receipts[0]?.result.content).toContain('foreground');
  expect(permission).not.toHaveBeenCalled();
  expect(budget.spentBudget).toBe(0);
});

it('composes a real read-dependent grep without discovery or bypassing a host path refusal', async () => {
  const { directory, budget, dispatch } = await fixture();
  await writeFile(path.join(directory, 'routing.txt'), 'target: value.mjs\n');
  const pilot = createScriptPilot({ ...dispatch, events: { beforeToolExecute: async (_name, input) =>
    input.path === 'routing.txt' || input.path === 'value.mjs' ? true : '[Tool Error] Path outside fixture' } }, budget);
  const result = await pilot.run(`
    const refused = await tools.read({path:'../outside.txt'});
    if (!refused.isError) throw new Error('Expected path refusal');
    const routing = await tools.read({path:'routing.txt'});
    const target = routing.content.match(/target: ([a-z.]+)/)[1];
    return await tools.grep({path:target,pattern:'export const value'});
  `, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts.map(receipt => receipt.name)).toEqual(['read', 'read', 'grep']);
  expect(result.receipts[0]?.result.isError).toBe(true);
  expect(result.receipts[2]?.input.path).toBe('value.mjs');
  expect(String(result.receipts[2]?.result.content)).toContain('export const value = 1');
  expect(budget.spentBudget).toBe(2);
});
