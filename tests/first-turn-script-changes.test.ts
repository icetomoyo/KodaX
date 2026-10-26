import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { executeTool, getToolDefinition } from '../packages/coding/src/tools/index.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import { projectModelToolDefinition } from '../packages/coding/src/tools/model-tool-definition.js';
import { withHostInvocation } from '../packages/coding/src/agent-runtime/host-invocation.js';
import { withScriptCells } from '../packages/coding/src/agent-runtime/script/run.js';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';

const limits = { timeoutMs: 10_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 12, maxTransferBytes: 128 * 1024 };
const names = ['changed_scope', 'changed_diff'];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-changes-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(totalBudget = 12) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-changes-'));
  directories.push(root);
  vi.stubEnv('KODAX_HOME', path.join(root, 'home'));
  await mkdir(path.join(root, 'src'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.quotepath', 'false']);
  await writeFile(path.join(root, 'src/value.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'src/removed.ts'), 'export const removed = true;\n');
  await writeFile(path.join(root, 'src/old.ts'), 'export const renamed = true;\n');
  git(root, ['add', 'src']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  const baseRef = git(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'src/value.ts'), 'export const value = 2;\n');
  git(root, ['add', 'src/value.ts']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'committed change']);
  await writeFile(path.join(root, 'src/value.ts'), 'export const value = 3;\n');
  await rename(path.join(root, 'src/old.ts'), path.join(root, 'src/renamed.ts'));
  git(root, ['add', 'src']);
  await writeFile(path.join(root, 'src/value.ts'), 'export const value = 4;\n');
  await rm(path.join(root, 'src/removed.ts'));
  await writeFile(path.join(root, 'src/新 file.ts'), 'export const added = "中文";\n');
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: root, gitRoot: root,
    mutationTracker: { files: new Map(), totalOps: 0 } };
  const budget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames: [...names], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: names, modelSelection: {} }) };
  return { root, baseRef, ctx, budget, dispatch };
}

// Only generated timestamps vary; all paths, counts, categories, warnings and diff bytes survive.
function stableScope(text: string): string {
  return text.replace(/^(Snapshot|Repository overview snapshot): \d{4}-\d{2}-\d{2}T[^\r\n]+$/gm, '$1: <TIME>');
}

it('preserves all native scope outputs for staged, unstaged, combined and committed changes', async () => {
  const { root, baseRef, ctx, budget, dispatch } = await fixture();
  dispatch.activeToolNames.push('changed_diff_bundle', 'undo');
  const pilot = createScriptPilot(dispatch, budget);
  expect(pilot.tools.map(tool => tool.name)).toEqual(names);
  for (const name of names) {
    const nativeModel = projectModelToolDefinition(getToolDefinition(name)!, { kind: 'builtin' });
    expect(pilot.tools.find(tool => tool.name === name)).toMatchObject({ description: nativeModel.description, input_schema: nativeModel.input_schema });
  }
  expect(pilot.tools.find(tool => tool.name === 'changed_diff')?.input_schema.required).toEqual(['paths']);
  expect(pilot.tools.find(tool => tool.name === 'changed_diff')?.input_schema.properties).not.toHaveProperty('path');
  const nativeBudget = { ...budget };
  const native = wrapCodingToolAsRunnable(getToolDefinition('changed_scope')!, (input, context) => executeTool('changed_scope', input, context), ctx, nativeBudget);
  const before = git(root, ['status', '--porcelain', '--', 'src']);
  for (const scope of ['staged', 'unstaged', 'all', 'compare']) {
    const input = { scope, base_ref: baseRef, refresh_overview: scope === 'all' };
    const baseline = await native.execute(input, { agent: { name: 'fixture', instructions: '' } });
    const result = await pilot.run(`return await tools.changed_scope(${JSON.stringify(input)});`, limits);
    expect(result.hadToolErrors, result.error).toBe(false);
    expect(stableScope(String(result.receipts[0]?.result.content))).toBe(stableScope(String(baseline.content)));
    expect(result.receipts[0]?.input).toEqual(input);
    expect(result.receipts[0]?.result.content).toContain('src/value.ts');
    if (scope === 'all') {
      expect(result.receipts[0]?.result.content).toContain('src/新 file.ts');
      expect(result.receipts[0]?.result.content).toContain('src/removed.ts');
      expect(result.receipts[0]?.result.content).toContain('src/renamed.ts');
    }
    if (scope === 'compare') expect(result.receipts[0]?.result.content).toContain('Changed files: 1');
  }
  expect(budget.spentBudget).toBe(4);
  expect(nativeBudget.spentBudget).toBe(4);
  expect(ctx.mutationTracker?.totalOps).toBe(0);
  expect(git(root, ['status', '--porcelain', '--', 'src'])).toBe(before);
});

it('preserves complete diff bytes, per-path paging, untracked content and legacy SDK inputs', async () => {
  const { baseRef, ctx, budget, dispatch } = await fixture();
  const pilot = createScriptPilot(dispatch, budget);
  const nativeBudget = { ...budget };
  const native = wrapCodingToolAsRunnable(getToolDefinition('changed_diff')!, (input, context) => executeTool('changed_diff', input, context), ctx, nativeBudget);
  const cases = [
    { input: { paths: ['src/value.ts', 'src/removed.ts', 'src/renamed.ts', 'src/新 file.ts', 'src/value.ts'] }, expected: 'Changed diff bundle for 4 file(s)' },
    { input: { paths: ['src/value.ts'], offset: 1, limit_per_path: 2 }, expected: 'offset=3 limit_per_path=2' },
    { input: { paths: ['src/value.ts'], offset: 3, limit_per_path: 800 }, expected: '+export const value = 4;' },
    { input: { paths: ['src/value.ts'], base_ref: baseRef, target_ref: 'HEAD' }, expected: '+export const value = 2;' },
    { input: { path: 'src/value.ts', limit: 800, target_path: 'src/value.ts' }, expected: '[End of diff]' },
  ];
  for (const { input, expected } of cases) {
    const baseline = await native.execute(input, { agent: { name: 'fixture', instructions: '' } });
    expect(baseline.isError).not.toBe(true);
    const result = await pilot.run(`return await tools.changed_diff(${JSON.stringify(input)});`, limits);
    expect(result.hadToolErrors, result.error).toBe(false);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]?.result.content).toBe(baseline.content);
    expect(result.receipts[0]?.result.content).toContain(expected);
    expect(result.receipts[0]?.result.metadata?.toolCall).toMatchObject({ name: 'changed_diff', input });
    if (input.paths?.includes('src/新 file.ts')) expect(result.receipts[0]?.result.content).toContain('+export const added = "中文";');
  }
  expect(budget.spentBudget).toBe(cases.length);
  expect(nativeBudget.spentBudget).toBe(cases.length);
  expect(ctx.mutationTracker?.totalOps).toBe(0);
});

it.each([2, 4])('charges exactly %i native-equivalent leaves across a dependent scope/diff task', async total => {
  const { ctx, budget, dispatch } = await fixture(total);
  const nativeBudget = { ...budget };
  const calls = [{ name: 'changed_scope', input: {} }, ...Array.from({ length: total - 1 }, () => ({ name: 'changed_diff', input: { paths: ['src/value.ts'] } }))];
  for (const call of calls) {
    const native = wrapCodingToolAsRunnable(getToolDefinition(call.name)!, (input, context) => executeTool(call.name, input, context), ctx, nativeBudget);
    expect((await native.execute(call.input, { agent: { name: 'fixture', instructions: '' } })).isError).not.toBe(true);
  }
  const result = await createScriptPilot(dispatch, budget).run(`
    const scope = await tools.changed_scope({});
    if (scope.isError || !scope.content.includes('src/value.ts')) throw new Error('Missing change evidence');
    for (let i=0;i<${total};i++) await tools.changed_diff({paths:['src/value.ts']});
  `, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(result.receipts.map(receipt => receipt.name)).toEqual([...calls.map(call => call.name), 'changed_diff']);
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
});

it.each([
  { name: 'changed_scope', invalid: { scope: 'unknown' }, valid: { scope: 'all' } },
  { name: 'changed_diff', invalid: { paths: ['../outside.txt'] }, valid: { paths: ['src/value.ts'] } },
])('preserves $name errors and recovers with original parameters through the same execution chain', async ({ name, invalid, valid }) => {
  const { ctx, budget, dispatch } = await fixture(2);
  const native = wrapCodingToolAsRunnable(getToolDefinition(name)!, (input, context) => executeTool(name, input, context), ctx);
  const baseline = await native.execute(invalid, { agent: { name: 'fixture', instructions: '' } });
  expect(baseline.isError).toBe(true);
  const result = await createScriptPilot(dispatch, budget).run(`
    const refused = await tools[${JSON.stringify(name)}](${JSON.stringify(invalid)});
    if (!refused.isError) throw new Error('Expected refusal');
    return await tools[${JSON.stringify(name)}](${JSON.stringify(valid)});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.input).toEqual(invalid);
  expect(result.receipts[0]?.result.content).toBe(baseline.content);
  expect(result.receipts[1]?.input).toEqual(valid);
  expect(budget.spentBudget).toBe(2);
});

it.each([
  { name: 'changed_scope', input: { target_path: '..' }, recovery: {} },
  { name: 'changed_diff', input: { target_path: '..', paths: ['outside.txt'] }, recovery: { paths: ['src/value.ts'] } },
])('retains native permission refusal and read-only recovery for $name without charging refusal', async ({ name, input, recovery }) => {
  const { budget, dispatch } = await fixture(1);
  const admitted = vi.fn();
  const permission = vi.fn(async (tool: string, parameters: Record<string, unknown>) =>
    names.includes(tool) && parameters.target_path !== '..' ? true : '[Blocked] Fixture workspace policy');
  const gated = { ...dispatch, events: { beforeToolExecute: permission, onToolExecutionStart: admitted } };
  const native = await runToolDispatch({ ...gated, abortSignal: undefined,
    toolBlocks: [{ type: 'tool_use', id: 'native-denied', name, input }] });
  expect(admitted).not.toHaveBeenCalled();
  const result = await createScriptPilot(gated, budget).run(`
    const denied = await tools[${JSON.stringify(name)}](${JSON.stringify(input)});
    if (!denied.isError) throw new Error('Expected policy refusal');
    return await tools[${JSON.stringify(name)}](${JSON.stringify(recovery)});
  `, limits);
  expect(result.receipts[0]?.result.content).toBe(native.get('native-denied'));
  expect(result.receipts[0]?.input).toEqual(input);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(permission).toHaveBeenCalledTimes(3);
  expect(admitted).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it.each(names)('keeps %s unavailable on Agent/excluded surfaces and respects live revocation', async name => {
  const { ctx, budget, dispatch } = await fixture();
  ctx.workMode = 'agent';
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
  ctx.workMode = 'coding';
  ctx.excludeTools = [name];
  expect(createScriptPilot(dispatch, budget).tools.map(tool => tool.name)).not.toContain(name);
  ctx.excludeTools = [];
  const pilot = createScriptPilot(dispatch, budget);
  dispatch.activeToolNames.splice(dispatch.activeToolNames.indexOf(name), 1);
  const result = await pilot.run(`return await tools[${JSON.stringify(name)}](${JSON.stringify(name === 'changed_diff' ? { paths: ['src/value.ts'] } : {})});`, limits);
  expect(result.receipts[0]?.result.isError).toBe(true);
  expect(result.receipts[0]?.result.content).toContain('outside this Script pilot');
  expect(budget.spentBudget).toBe(0);
});

it.each(names)('settles the admitted %s call after cancellation and does not execute the next leaf', async name => {
  const { root, budget, dispatch } = await fixture();
  const controller = new AbortController();
  const ended = vi.fn();
  const admitted = vi.fn(() => { controller.abort(); });
  const input = name === 'changed_diff' ? { paths: ['src/value.ts'] } : {};
  const nativeController = new AbortController();
  const nativeAdmitted = vi.fn(() => { nativeController.abort(); });
  const nativeEnded = vi.fn();
  const baseline = await runToolDispatch({ ...dispatch, abortSignal: nativeController.signal,
    events: { onToolExecutionStart: nativeAdmitted, onToolExecutionEnd: nativeEnded },
    toolBlocks: [{ type: 'tool_use', id: 'native-cancelled', name, input }] });
  expect(nativeAdmitted).toHaveBeenCalledOnce();
  expect(nativeEnded).toHaveBeenCalledOnce();
  const result = await createScriptPilot({ ...dispatch, abortSignal: controller.signal,
    events: { onToolExecutionStart: admitted, onToolExecutionEnd: ended } }, budget).run(`
    await tools[${JSON.stringify(name)}](${JSON.stringify(input)});
    await tools.changed_diff({paths:['src/新 file.ts']});
  `, limits);
  expect(result.status).toBe('cancelled');
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.name).toBe(name);
  expect(result.receipts[0]?.result.content).toContain(name === 'changed_scope' ? 'Changed scope for' : 'Changed diff bundle');
  expect(stableScope(String(result.receipts[0]?.result.content))).toBe(stableScope(String(baseline.get('native-cancelled'))));
  expect(admitted).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
  if (name === 'changed_scope') {
    const saved = JSON.parse(await readFile(path.join(root, '.agent/repo-intelligence/changed-scope.json'), 'utf8')) as { files: { path: string }[] };
    expect(saved.files.map(file => file.path)).toContain('src/value.ts');
  }
  const preCancelled = await createScriptPilot({ ...dispatch, abortSignal: controller.signal,
    events: { onToolExecutionStart: admitted } }, budget).run(`return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`, limits);
  expect(preCancelled).toMatchObject({ status: 'cancelled', receipts: [] });
  expect(admitted).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it('retains the native bounded scope report and its explicit omitted-files warning', async () => {
  const { root, ctx, budget, dispatch } = await fixture();
  for (let i = 0; i < 25; i++) await writeFile(path.join(root, `src/new-${i}.ts`), `export const v${i} = 1;\n`);
  const baseline = await executeTool('changed_scope', {}, ctx);
  const result = await createScriptPilot(dispatch, budget).run('return await tools.changed_scope({});', limits);
  expect(result.hadToolErrors).toBe(false);
  expect(stableScope(String(result.receipts[0]?.result.content))).toBe(stableScope(String(baseline)));
  expect(result.receipts[0]?.result.content).toContain('more file(s)');
  expect(result.receipts[0]?.result.content).toContain('untracked files excluded');
});

it('keeps the full native diff in host receipts if a deliberately small cell transfer limit is exceeded', async () => {
  const { root, ctx, budget, dispatch } = await fixture();
  await writeFile(path.join(root, 'src/large.ts'), `export const text = '${'x'.repeat(8000)}';\n`);
  const input = { paths: ['src/large.ts'] };
  const baseline = await executeTool('changed_diff', input, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`return await tools.changed_diff(${JSON.stringify(input)});`,
    { ...limits, maxTransferBytes: 2048 });
  expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('transfer limit') });
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(budget.spentBudget).toBe(1);
});

it('persists a dependent scope-to-diff task in the parent Run with two leaves and no discovery or alias calls', async () => {
  const { root, ctx, budget } = await fixture(2);
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-changes-'));
  directories.push(storageRoot);
  vi.stubEnv('KODAX_HOME', storageRoot);
  const storage = new FileSessionStorage({ sessionsDir: path.join(storageRoot, 'sessions'), configHome: storageRoot, cwd: root });
  const paths = ['src/value.ts', 'src/removed.ts', 'src/renamed.ts', 'src/新 file.ts'].sort();
  const baseline = await executeTool('changed_diff', { paths }, ctx);
  const admitted: string[] = [];
  await withHostInvocation({ provider: 'unconfigured-provider', lsp: false,
    session: { id: 'changes-session', storage },
    context: { executionCwd: root, gitRoot: root, runtimeRunId: 'changes-run', managedWorkBudget: budget },
    events: { onToolExecutionStart: call => { admitted.push(call.name); } },
  }, 'Review the single source area', parent => withScriptCells(parent, limits, async runCell => {
    const result = await runCell(`
      const scope = await tools.changed_scope({});
      if (scope.isError) throw new Error(scope.content);
      const paths = scope.content.split('\\n').flatMap(line => {
        const match = line.match(/^- \\S+ (.+) \\[source\\] ->/);
        return match ? [match[1]] : [];
      }).sort();
      return await tools.changed_diff({paths});
    `);
    expect(result.status, result.error).toBe('completed');
    expect(result.hadToolErrors).toBe(false);
    expect(result.receipts.map(receipt => receipt.name)).toEqual(names);
    expect(result.receipts[1]?.input, String(result.receipts[0]?.result.content)).toEqual({ paths });
    expect(result.receipts[1]?.result.content).toBe(baseline);
  }));
  expect(admitted).toEqual(names);
  expect(budget.spentBudget).toBe(2);
  const records = (await storage.load('changes-session'))?.extensionRecords ?? [];
  const settled = records.filter(record => record.type === 'call.settled');
  expect(settled).toHaveLength(2);
  expect(settled[1]?.data).toMatchObject({ runId: 'changes-run', data: {
    name: 'changed_diff', input: { paths }, result: { content: baseline, isError: false },
  } });
  expect(records.at(-1)?.data).toMatchObject({ data: { status: 'completed', spentBudget: 2 } });
});
