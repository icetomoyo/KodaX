import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withHostInvocation } from '../packages/coding/src/agent-runtime/host-invocation.js';
import { withScriptCells } from '../packages/coding/src/agent-runtime/script/run.js';
import type { ScriptCellResult } from '../packages/coding/src/agent-runtime/script/cell.js';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import type { KodaXOptions } from '../packages/coding/src/types.js';
import { assertTrustedTextMutationPolicy } from '../packages/coding/src/trusted-text-mutation.js';
import { createTrustedTextMutationHost } from '../src/windows-text-transaction.js';
import { executeTool, getToolDefinition } from '../packages/coding/src/tools/index.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import { createExtensionRuntimeSessionController } from '../packages/coding/src/agent-runtime/middleware/extension-queue.js';
import { createComplexReadBoundary } from './first-turn-complex-guard.js';

const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-parent-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function fixture(totalBudget = 4) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-parent-'));
  directories.push(root);
  vi.stubEnv('KODAX_HOME', root);
  vi.stubEnv('NODE_ENV', 'production');
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  const trustedHost = createTrustedTextMutationHost(() => [root], target => assertTrustedTextMutationPolicy(target, root));
  const budget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const options: KodaXOptions = { provider: 'unconfigured-provider', lsp: false,
    session: { id: 'parent-session', storage, resume: true },
    context: { runtimeRunId: 'parent-run', executionCwd: root, gitRoot: root,
      managedWorkBudget: budget, trustedTextMutationHost: trustedHost } };
  await writeFile(path.join(root, 'value.txt'), 'before');
  return { root, storage, trustedHost, budget, options };
}

it('shares parent backup authority and budget across cells and native undo without extra discovery calls', async () => {
  const { root, storage, trustedHost, budget, options } = await fixture();
  const commit = vi.spyOn(trustedHost, 'commit');
  let retained!: (code: string) => Promise<ScriptCellResult>;
  await withHostInvocation(options, 'Read, edit and restore the fixture', parent => withScriptCells(parent, limits, async runCell => {
    retained = runCell;
    const first = await runCell("await tools.read({path:'value.txt'}); await tools.edit({path:'value.txt',old_string:'before',new_string:'after'});");
    expect(first.receipts.map(receipt => receipt.name)).toEqual(['read', 'edit']);
    expect(first.hadToolErrors).toBe(false);
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
    const native = wrapCodingToolAsRunnable(getToolDefinition('undo')!, (input, ctx) => executeTool('undo', input, ctx), parent.ctx, budget);
    expect((await native.execute({}, { agent: { name: 'fixture', instructions: '' } })).content).toContain('Restored:');
    const second = await runCell("return await tools.read({path:'value.txt'});");
    expect(second.receipts).toHaveLength(1);
    expect(second.receipts[0]?.result.content).toContain('before');
    expect(budget.spentBudget).toBe(4);
  }));
  await expect(retained("return await tools.write({path:'value.txt',content:'late'});")).rejects.toThrow(/closed/i);
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
  expect(commit).toHaveBeenCalledTimes(2);
  const records = (await storage.load('parent-session'))?.extensionRecords ?? [];
  const starts = records.filter(record => record.type === 'cell.started');
  expect(starts).toHaveLength(2);
  expect(starts.map(record => record.data)).toEqual([
    expect.objectContaining({ runId: 'parent-run', cellId: expect.any(String) }),
    expect.objectContaining({ runId: 'parent-run', cellId: expect.any(String) }),
  ]);
  expect(starts[0]?.data).not.toEqual(starts[1]?.data);
  expect(records.filter(record => record.type === 'call.settled')).toHaveLength(3);
});

it.each([2, 4])('retains the %i-unit parent budget across cells and refuses extra writes', async total => {
  const { root, budget, options } = await fixture(total);
  await withHostInvocation(options, 'Bound all cells to the parent budget', parent => withScriptCells(parent, limits, async runCell => {
    for (let i = 0; i < total; i++) {
      const cell = await runCell(`return await tools.write({path:'value.txt',content:'value${i}'});`);
      expect(cell.hadToolErrors).toBe(false);
    }
    const extra = await runCell("return await tools.write({path:'value.txt',content:'must not execute'});");
    expect(extra.receipts[0]?.result.content).toContain('budget exhausted');
  }));
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('value' + (total - 1));
  expect(budget.spentBudget).toBe(total);
});

it('attaches a finite fallback budget to the parent instead of replenishing it when a cell scope reopens', async () => {
  const { root, options } = await fixture();
  delete options.context!.managedWorkBudget;
  await withHostInvocation(options, 'Fallback budget belongs to the parent', async parent => {
    const bounded = { ...limits, maxCalls: 2 };
    await withScriptCells(parent, bounded, runCell => runCell("return await tools.write({path:'value.txt',content:'after'});"));
    await withScriptCells(parent, bounded, runCell => runCell("return await tools.read({path:'value.txt'});"));
    const exhausted = await withScriptCells(parent, bounded, runCell => runCell("return await tools.write({path:'value.txt',content:'must not execute'});"));
    expect(exhausted.receipts[0]?.result.content).toContain('budget exhausted');
    expect(parent.ctx.managedWorkBudget?.spentBudget).toBe(2);
  });
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
});

it.each(['abort', 'return', 'throw'] as const)('drains an admitted write on parent %s and rejects retained cell entry points', async ending => {
  const { root, storage, trustedHost, budget, options } = await fixture();
  const controller = new AbortController();
  options.abortSignal = controller.signal;
  const commit = trustedHost.commit.bind(trustedHost);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const committing = vi.spyOn(trustedHost, 'commit').mockImplementation(async input => { entered(); await gate; return commit(input); });
  let retained!: (code: string) => Promise<ScriptCellResult>;
  let child!: Promise<ScriptCellResult>;
  let finished = false;
  const operation = withHostInvocation(options, 'Cancel only after admission', parent => withScriptCells(parent, limits, async runCell => {
    retained = runCell;
    child = runCell("await tools.write({path:'value.txt',content:'must not commit'}); await tools.write({path:'value.txt',content:'must not start'});");
    await ready;
    if (ending === 'abort') { controller.abort(); await child; }
    if (ending === 'throw') throw new Error('Parent failed');
    return 'done';
  })).then(value => { finished = true; return { value, error: undefined }; },
    (error: unknown) => { finished = true; return { value: undefined, error: String(error) }; });
  try {
    await ready;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    await expect(retained("return await tools.read({path:'value.txt'});")).rejects.toThrow();
    release();
    const result = await operation;
    if (ending === 'throw') expect(result.error).toContain('Parent failed');
    else expect(result.value).toBe('done');
    expect(await child).toMatchObject({ status: 'cancelled', receipts: [{ name: 'write', result: { isError: true } }] });
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
    expect(committing).toHaveBeenCalledTimes(1);
    expect(budget.spentBudget).toBe(1);
    expect((await storage.load('parent-session'))?.extensionRecords?.at(-1)?.data)
      .toMatchObject({ runId: 'parent-run', data: { status: 'cancelled', spentBudget: 1 } });
    await expect(retained("return 1;")).rejects.toThrow(/closed/i);
  } finally { release(); await operation; }
});

it('honors parent cancellation after a shell refusal, without committing or replaying later effects', async () => {
  const { root, trustedHost, budget, options } = await fixture();
  const controller = new AbortController(); options.abortSignal = controller.signal;
  options.guardrails = [createComplexReadBoundary(root)];
  const commit = trustedHost.commit.bind(trustedHost);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const committing = vi.spyOn(trustedHost, 'commit').mockImplementation(async input => { entered(); await gate; return commit(input); });
  const operation = withHostInvocation(options, 'Cancel during recovery', parent => withScriptCells(parent, limits, async runCell => {
    const cell = runCell("const refusal = await tools.bash({command:'mkdir tests 2>nul & dir tests'}); if (!refusal.isError) throw Error('Missing refusal'); await tools.write({path:'value.txt',content:'must not commit'}); await tools.write({path:'later.txt',content:'must not start'});");
    await ready; controller.abort(); release();
    return await cell;
  }));
  try {
    const cell = await operation;
    expect(cell.status).toBe('cancelled');
    expect(cell.receipts).toHaveLength(2);
    expect(cell.receipts[0]).toMatchObject({ name: 'bash', result: { isError: true,
      content: expect.stringContaining('Directory creation must stay in fixture scratch.') } });
    expect(cell.receipts[1]).toMatchObject({ name: 'write', result: { isError: true } });
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
    await expect(readFile(path.join(root, 'later.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'tests'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // Production work budget charges admitted execution, not a pre-execution refusal.
    // The separate eval attempt cap still counts refused calls.
    expect(committing).toHaveBeenCalledTimes(1); expect(budget.spentBudget).toBe(1);
  } finally { release(); await operation; }
});

it('keeps cells sequential and edit recovery state shared while isolating VM globals', async () => {
  const { root, budget, options } = await fixture();
  await withHostInvocation(options, 'Repair only the failed edit', parent => withScriptCells(parent, limits, async runCell => {
    const first = runCell("globalThis.previousCell = 7; return await tools.edit({path:'value.txt',old_string:'absent',new_string:'bad'});");
    await expect(runCell("return await tools.write({path:'value.txt',content:'concurrent'});")).rejects.toThrow(/active cell/i);
    const failed = await first;
    expect(failed.hadToolErrors).toBe(true);
    expect(failed.receipts[0]?.result.metadata?.editRecoveryMessages).toEqual([expect.stringContaining('unique old_string')]);
    const blocked = await runCell("return [typeof previousCell, await tools.write({path:'value.txt',content:'overwrite'})];");
    expect(blocked.value).toEqual(['undefined', expect.objectContaining({ isError: true })]);
    expect(blocked.receipts[0]?.result.content).toContain('BLOCKED_AFTER_EDIT_FAILURE');
    expect(budget.spentBudget).toBe(1);
    const repaired = await runCell("return await tools.edit({path:'value.txt',old_string:'before',new_string:'after'});");
    expect(repaired.hadToolErrors).toBe(false);
    expect(parent.state.blockedEditWrites.size).toBe(0);
    expect(budget.spentBudget).toBe(2);
  }));
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
});

it('closes the cell scope after receipt persistence fails instead of admitting another cell', async () => {
  const { root, storage, options, budget } = await fixture();
  const save = storage.save.bind(storage);
  let fail = true;
  vi.spyOn(storage, 'save').mockImplementation(async (id, data) => {
    if (fail && data.extensionRecords?.at(-1)?.type === 'call.settled') {
      fail = false;
      throw new Error('Fixture receipt persistence failed');
    }
    return save(id, data);
  });
  await withHostInvocation(options, 'Do not continue after lost durability', parent => withScriptCells(parent, limits, async runCell => {
    const failed = await runCell("await tools.write({path:'value.txt',content:'retained'});");
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('Fixture receipt persistence failed') });
    await expect(runCell("await tools.write({path:'value.txt',content:'must not execute'});")).rejects.toThrow(/closed/i);
  }));
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('retained');
  expect(budget.spentBudget).toBe(1);
});

it('rechecks parent permissions between cells without charging a refused mutation or admitting native controls', async () => {
  const { root, budget, options } = await fixture();
  let canWrite = true;
  const permission = vi.fn(async (name: string) => name === 'write' && !canWrite ? '[Blocked] Parent is now read-only' : true);
  options.events = { beforeToolExecute: permission };
  await withHostInvocation(options, 'Live permission revocation', parent => withScriptCells(parent, limits, async runCell => {
    const first = await runCell("return [typeof tools.undo, typeof tools.spawn_agent, typeof tools.tool_call, await tools.read({path:'value.txt'})];");
    expect(first.value).toEqual(['undefined', 'undefined', 'undefined', expect.objectContaining({ isError: false })]);
    canWrite = false;
    const denied = await runCell("return await tools.write({path:'value.txt',content:'must not execute'});");
    expect(denied.receipts[0]?.result).toMatchObject({ content: '[Blocked] Parent is now read-only', isError: true });
    expect(denied.receipts[0]?.input).toEqual({ path: 'value.txt', content: 'must not execute' });
    expect(budget.spentBudget).toBe(1);
    const recovered = await runCell("return await tools.read({path:'value.txt'});");
    expect(recovered.receipts[0]?.result.content).toContain('before');
    expect(budget.spentBudget).toBe(2);
  }));
  expect(permission.mock.calls.map(([name]) => name)).toEqual(['read', 'write', 'read']);
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
});

it('honors parent inventory replacement between cells and before leaf admission', async () => {
  const { options, budget } = await fixture();
  await withHostInvocation(options, 'Revoke existing inventory bindings', async parent => {
    const controller = createExtensionRuntimeSessionController(parent.state);
    const original = [...parent.state.activeTools];
    await withScriptCells(parent, limits, async runCell => {
      expect((await runCell("return await tools.read({path:'value.txt'});")).hadToolErrors).toBe(false);
      controller.setActiveTools([]);
      expect((await runCell("return typeof tools.read;")).value).toBe('undefined');
      controller.setActiveTools(original);
      parent.options.events = { beforeToolExecute: async () => { controller.setActiveTools([]); return true; } };
      const revoked = await runCell("return await tools.read({path:'value.txt'});");
      expect(revoked.hadToolErrors).toBe(true);
      expect(revoked.receipts[0]?.result.content).toContain('outside this Script pilot');
      expect(budget.spentBudget).toBe(1);
    });
  });
});

it('observes an abandoned cell rejection and propagates persistence failure through parent teardown', async () => {
  const { options, storage, budget } = await fixture();
  const failure = new Error('Fixture start persistence failed');
  vi.spyOn(storage, 'save').mockRejectedValue(failure);
  await expect(withHostInvocation(options, 'Abandon a cell whose start cannot be saved', parent => withScriptCells(parent, limits, async runCell => {
    void runCell("await tools.write({path:'value.txt',content:'must not execute'});");
  }))).rejects.toBe(failure);
  // Let Node report any unobserved outer promise; Vitest treats it as an error.
  await new Promise(resolve => setImmediate(resolve));
  expect(budget.spentBudget).toBe(0);
});

it('preserves both the parent failure and pending cell persistence failure on teardown', async () => {
  const { options, storage } = await fixture();
  const parentFailure = new Error('Fixture parent failed');
  const storageFailure = new Error('Fixture storage failed');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storage, 'save').mockImplementation(async () => { entered(); await gate; throw storageFailure; });
  let cellFailure: unknown;
  const operation = withHostInvocation(options, 'Retain both failures', parent => withScriptCells(parent, limits, async runCell => {
    void runCell("return 1;").catch((error: unknown) => { cellFailure = error; });
    await ready;
    throw parentFailure;
  }));
  const checked = expect(operation).rejects.toMatchObject({ errors: [parentFailure, storageFailure] });
  try {
    await ready;
    release();
    await checked;
    expect(cellFailure).toBe(storageFailure);
  } finally { release(); await checked; }
});

it('completes read/edit/test/fix/test across cells with the same leaf work as native tools and no replay', async () => {
  const script = await fixture(5);
  const native = await fixture(5);
  for (const fixture of [script, native]) {
    await writeFile(path.join(fixture.root, 'value.mjs'), 'export const value = 1;\n');
    await writeFile(path.join(fixture.root, 'fixture.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('three',()=>assert.equal(value,3));\n");
    fixture.options.context!.resolveShellPermissionMode = () => 'full-access';
    fixture.options.context!.authorizeShellHostExecution = async () => true;
  }
  const calls = [
    { name: 'read', input: { path: 'value.mjs' } },
    { name: 'edit', input: { path: 'value.mjs', old_string: 'value = 1', new_string: 'value = 2' } },
    { name: 'bash', input: { command: 'node --test fixture.test.mjs' } },
    { name: 'edit', input: { path: 'value.mjs', old_string: 'value = 2', new_string: 'value = 3' } },
    { name: 'bash', input: { command: 'node --test fixture.test.mjs' } },
  ];
  const commits = vi.spyOn(script.trustedHost, 'commit');
  const cells: ScriptCellResult[] = [];
  const toCode = (subset: typeof calls) => subset.map(call => `await tools[${JSON.stringify(call.name)}](${JSON.stringify(call.input)});`).join('\n');
  await withHostInvocation(script.options, 'Fix a failed test without replaying completed edits', parent => withScriptCells(parent, limits, async runCell => {
    cells.push(await runCell(toCode(calls.slice(0, 3))));
    expect(cells[0]).toMatchObject({ status: 'completed', hadToolErrors: true });
    expect(cells[0]?.receipts[2]?.result).toMatchObject({ isError: true, metadata: { shellExecutionOutcome: { success: false } } });
    expect(await readFile(path.join(script.root, 'value.mjs'), 'utf8')).toBe('export const value = 2;\n');
    cells.push(await runCell(toCode(calls.slice(3))));
    expect(cells[1]).toMatchObject({ status: 'completed', hadToolErrors: false });
    expect(cells[1]?.receipts[1]?.result).toMatchObject({ metadata: { shellExecutionOutcome: { success: true } } });
    expect(cells[1]?.receipts[1]?.result.content).toMatch(/pass\s+1/i);
  }));
  const nativeShell: boolean[] = [];
  await withHostInvocation(native.options, 'Native leaf baseline', async parent => {
    parent.ctx.reportShellExecutionOutcome = outcome => { nativeShell.push(outcome.success); };
    for (const call of calls) {
      const tool = wrapCodingToolAsRunnable(getToolDefinition(call.name)!, (input, ctx) => executeTool(call.name, input, ctx), parent.ctx, native.budget);
      await tool.execute(call.input, { agent: { name: 'fixture', instructions: '' } });
    }
  });
  expect(nativeShell).toEqual([false, true]);
  expect(cells.flatMap(cell => cell.receipts.map(receipt => receipt.name))).toEqual(calls.map(call => call.name));
  expect(script.budget.spentBudget).toBe(5);
  expect(native.budget.spentBudget).toBe(5);
  expect(commits).toHaveBeenCalledTimes(2);
  for (const fixture of [script, native]) expect(await readFile(path.join(fixture.root, 'value.mjs'), 'utf8')).toBe('export const value = 3;\n');
}, 30_000);
