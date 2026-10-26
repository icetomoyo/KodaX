import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { withScriptCells } from '../packages/coding/src/agent-runtime/script/run.js';
import { withHostInvocation } from '../packages/coding/src/agent-runtime/host-invocation.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { shutdownRepoIntelligenceWorkerForTest } from '../packages/coding/src/repo-intelligence/semantic-worker-client.js';
import * as repoWorker from '../packages/coding/src/repo-intelligence/semantic-worker-client.js';
import { executeTool, getToolDefinition } from '../packages/coding/src/tools/index.js';
import { projectModelToolDefinition } from '../packages/coding/src/tools/model-tool-definition.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';

const relations = ['relationship_scan', 'module_context', 'symbol_context', 'process_context', 'impact_estimate'];
const names = ['repo_overview', 'semantic_lookup', 'cyclic_dependencies', ...relations];
const limits = { timeoutMs: 15_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };
const directories: string[] = [];
afterEach(async () => {
  await shutdownRepoIntelligenceWorkerForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-repo-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function fixture(totalBudget = 8) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-repo-'));
  directories.push(root);
  vi.stubEnv('KODAX_HOME', path.join(root, 'home'));
  vi.stubEnv('KODAX_REPO_INTELLIGENCE', 'full');
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', '10000');
  execFileSync('git', ['init'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  for (const name of ['app', 'shared']) {
    await mkdir(path.join(root, 'packages', name, 'src'), { recursive: true });
    await writeFile(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  await writeFile(path.join(root, 'packages/app/src/index.ts'), "import { NameService } from '../../shared/src/index';\nexport function startServer() { return new NameService(); }\n");
  await writeFile(path.join(root, 'packages/shared/src/index.ts'), "import { startServer } from '../../app/src/index';\nexport class NameService { start() { return startServer(); } }\n");
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: root, gitRoot: root,
    mutationTracker: { files: new Map(), totalOps: 0 } };
  const budget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames: [...names], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: names, modelSelection: {} }) };
  return { root, ctx, budget, dispatch };
}

function inputFor(name: string): Record<string, unknown> {
  if (name === 'relationship_scan') return { symbol: 'startServer', include_text_search: true, include_lsp: true, depth: 2 };
  if (name === 'module_context') return { module: 'packages/app' };
  if (name === 'symbol_context' || name === 'impact_estimate') return { symbol: 'startServer' };
  if (name === 'process_context') return { entry: 'startServer' };
  return name === 'semantic_lookup' ? { query: 'NameService', kind: 'symbol', limit: 1 } : {};
}

// Preserve all evidence and warnings; only generated timestamps are nondeterministic.
function stable(content: unknown): string {
  return String(content).replace(/^(Snapshot: \S+ @ |- generatedAt: )\d{4}-\d{2}-\d{2}T[^\r\n]+$/gm, '$1<TIME>');
}

it('projects the native contracts and preserves real overview, symbol and cycle evidence', async () => {
  const { root, ctx, budget, dispatch } = await fixture();
  dispatch.activeToolNames.push('undo', 'tool_call');
  const pilot = createScriptPilot(dispatch, budget);
  expect(pilot.tools.map(tool => tool.name)).toEqual(names);
  const nativeBudget = { ...budget };
  for (const name of names) {
    const definition = getToolDefinition(name)!;
    expect(pilot.tools.find(tool => tool.name === name)).toEqual(projectModelToolDefinition(definition, { kind: 'builtin' }));
    const native = wrapCodingToolAsRunnable(definition, (input, context) => executeTool(name, input, context), ctx, nativeBudget);
    const baseline = await native.execute(inputFor(name), { agent: { name: 'fixture', instructions: '' } });
    const result = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.hadToolErrors).toBe(false);
    expect(stable(result.receipts[0]?.result.content)).toBe(stable(baseline.content));
    expect(result.value).toEqual(result.receipts[0]?.result);
    if (name === 'repo_overview') expect(result.receipts[0]?.result.content).toContain('packages/app/package.json');
    if (name === 'semantic_lookup') {
      expect(result.receipts[0]?.result.content).toContain('packages/shared/src/index.ts');
      expect(result.receipts[0]?.result.content).toContain('NameService');
      expect(result.receipts[0]?.result.content).toContain('Trust: workspace');
    }
    if (name === 'cyclic_dependencies') {
      expect(result.receipts[0]?.result.content).toContain('1 cycle(s) found');
      expect(result.receipts[0]?.result.content).toContain('2-hop:');
      expect(result.receipts[0]?.result.content).toContain('packages/app');
      expect(result.receipts[0]?.result.content).toContain('packages/shared');
    }
    if (relations.includes(name)) {
      expect(result.receipts[0]?.result.content).toContain('packages/app');
      expect(result.receipts[0]?.result.content).toContain('startServer');
      expect(result.receipts[0]?.result.content).toMatch(/Confidence:|confidence=/);
    }
    if (name === 'relationship_scan') {
      for (const evidence of ['Upstream', 'Downstream', 'Impact', 'Evidence', 'Gaps', 'Text-search validation',
        'LSP service is unavailable', 'Requested depth 2']) expect(result.receipts[0]?.result.content).toContain(evidence);
    }
  }
  expect(budget.spentBudget).toBe(names.length);
  expect(nativeBudget.spentBudget).toBe(names.length);
  expect(ctx.mutationTracker?.totalOps).toBe(0);
  expect(await readFile(path.join(root, 'packages/shared/src/index.ts'), 'utf8')).toContain('export class NameService');
}, 30_000);

it('refreshes real overview and symbol snapshots without a separate discovery call', async () => {
  const { root, ctx, budget, dispatch } = await fixture();
  await executeTool('repo_overview', {}, ctx);
  await executeTool('semantic_lookup', inputFor('semantic_lookup'), ctx);
  await mkdir(path.join(root, 'packages/new/src'), { recursive: true });
  await writeFile(path.join(root, 'packages/new/package.json'), '{"name":"@fixture/new"}');
  await writeFile(path.join(root, 'packages/new/src/index.ts'), 'export class FreshSymbol {}\n');
  const result = await createScriptPilot(dispatch, budget).run(`
    const overview = await tools.repo_overview({refresh:true});
    if (!overview.content.includes('packages/new/package.json')) throw new Error('Stale overview');
    return await tools.semantic_lookup({query:'FreshSymbol', kind:'symbol', refresh:true});
  `, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.hadToolErrors).toBe(false);
  expect(result.receipts.map(receipt => receipt.name)).toEqual(names.slice(0, 2));
  expect(result.receipts[1]?.result.content).toContain('packages/new/src/index.ts');
  const baseline = await executeTool('semantic_lookup', { query: 'FreshSymbol', kind: 'symbol' }, ctx);
  expect(stable(result.receipts[1]?.result.content)).toBe(stable(baseline));
  expect(budget.spentBudget).toBe(2);
}, 30_000);

it.each([2, 4])('charges exactly %i admitted leaves, matching native work without double billing', async total => {
  const { ctx, budget, dispatch } = await fixture(total);
  const nativeBudget = { ...budget };
  for (let i = 0; i < total; i++) {
    const name = names[i % names.length]!;
    const native = wrapCodingToolAsRunnable(getToolDefinition(name)!, (input, context) => executeTool(name, input, context), ctx, nativeBudget);
    expect((await native.execute(inputFor(name), { agent: { name: 'fixture', instructions: '' } })).isError).not.toBe(true);
  }
  const calls = Array.from({ length: total + 1 }, (_, i) => `await tools.${names[i % names.length]}(${JSON.stringify(inputFor(names[i % names.length]!))});`).join('\n');
  const result = await createScriptPilot(dispatch, budget).run(calls, limits);
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
}, 30_000);

it.each(names)('preserves native permission denial and subsequent read-only recovery for %s', async name => {
  const { budget, dispatch } = await fixture(1);
  const admitted = vi.fn();
  // Deny the first call at the host boundary, then allow the same parameters after policy changes.
  let allowed = false;
  const permission = vi.fn(async () => allowed ? true : '[Blocked] Fixture read policy');
  const gated = { ...dispatch, events: { beforeToolExecute: permission, onToolExecutionStart: admitted } };
  const input = inputFor(name);
  const baseline = await runToolDispatch({ ...gated, abortSignal: undefined,
    toolBlocks: [{ type: 'tool_use', id: 'native-denied', name, input }] });
  const pilot = createScriptPilot(gated, budget);
  const denied = await pilot.run(`return await tools.${name}(${JSON.stringify(input)});`, limits);
  expect(denied.receipts[0]?.result.content).toBe(baseline.get('native-denied'));
  expect(denied.receipts[0]?.input).toEqual(input);
  expect(denied.receipts[0]?.result.isError).toBe(true);
  expect(budget.spentBudget).toBe(0);
  expect(admitted).not.toHaveBeenCalled();
  allowed = true;
  const recovered = await pilot.run(`return await tools.${name}(${JSON.stringify(input)});`, limits);
  expect(recovered.hadToolErrors, recovered.error).toBe(false);
  expect(recovered.receipts[0]?.input).toEqual(input);
  expect(budget.spentBudget).toBe(1);
  expect(admitted).toHaveBeenCalledOnce();
}, 30_000);

it('preserves admitted argument errors and recovers within the same cell', async () => {
  const { ctx, budget, dispatch } = await fixture(2);
  const baseline = await executeTool('semantic_lookup', {}, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`
    const invalid = await tools.semantic_lookup({});
    if (!invalid.isError) throw new Error('Expected required-query refusal');
    return await tools.semantic_lookup({query:'NameService', kind:'symbol', limit:1});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(result.receipts[0]?.input).toEqual({});
  expect(result.receipts[1]?.result.content).toContain('packages/shared/src/index.ts');
  expect(budget.spentBudget).toBe(2);
}, 30_000);

it('preserves disabled-worker warnings instead of fabricating a successful empty analysis', async () => {
  const { ctx, budget, dispatch } = await fixture();
  vi.stubEnv('KODAX_REPO_INTELLIGENCE', 'off');
  for (const name of names.slice(1)) {
    const baseline = await executeTool(name, inputFor(name), ctx);
    const result = await createScriptPilot(dispatch, budget).run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
    expect(stable(result.receipts[0]?.result.content)).toBe(stable(baseline));
    expect(result.receipts[0]?.result.content).toMatch(/unavailable|disabled/);
    expect(result.receipts[0]?.result.content).not.toContain('No circular dependencies found.');
  }
  expect(budget.spentBudget).toBe(names.length - 1);
}, 30_000);

it.each(['semantic_lookup', 'cyclic_dependencies'])('preserves %s warming feedback and permits recovery through the same worker path', async name => {
  const { ctx, budget, dispatch } = await fixture(2);
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', '250');
  // A controlled worker delay exercises the real timeout, rendering and dispatch chain.
  const delayed = name === 'semantic_lookup'
    ? vi.spyOn(repoWorker, 'semanticLookup').mockImplementation(() => new Promise(() => {}))
    : vi.spyOn(repoWorker, 'getCyclicDependencyAnalysis').mockImplementation(() => new Promise(() => {}));
  const baseline = await executeTool(name, inputFor(name), ctx);
  const pilot = createScriptPilot(dispatch, budget);
  const warming = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(stable(warming.receipts[0]?.result.content)).toBe(stable(baseline));
  expect(warming.receipts[0]?.result.content).toContain('still warming');
  expect(warming.receipts[0]?.result.content).not.toContain('No circular dependencies found.');
  expect(delayed).toHaveBeenCalledTimes(2);
  delayed.mockRestore();
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', '10000');
  const recovered = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(recovered.status, recovered.error).toBe('completed');
  expect(recovered.receipts[0]?.result.content).toContain(name === 'semantic_lookup' ? 'packages/shared/src/index.ts' : '1 cycle(s) found');
  expect(recovered.receipts[0]?.result.content).not.toContain('still warming');
  expect(budget.spentBudget).toBe(2);
}, 30_000);

it('keeps native semantic result limits and all returned evidence in the guest and receipts', async () => {
  const { root, ctx, budget, dispatch } = await fixture();
  for (const name of ['extra-a', 'extra-b']) {
    await writeFile(path.join(root, `packages/shared/src/${name}.ts`), 'export class NameService {}\n');
  }
  const input = inputFor('semantic_lookup');
  const baseline = await executeTool('semantic_lookup', input, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`return await tools.semantic_lookup(${JSON.stringify(input)});`, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts[0]?.result.content).toContain('RESULT_LIMIT_REACHED: limit=1');
  expect(stable(result.receipts[0]?.result.content)).toBe(stable(baseline));
  expect(result.value).toEqual(result.receipts[0]?.result);
  expect(result.receipts[0]?.result.content).toContain('Narrow `query`, `kind`, or `target_path`');
  expect(budget.spentBudget).toBe(1);
}, 30_000);

it.each(relations)('refreshes %s from changed source and returns complete native evidence', async name => {
  const { root, ctx, budget, dispatch } = await fixture(1);
  await executeTool(name, inputFor(name), ctx);
  await writeFile(path.join(root, 'packages/app/src/index.ts'), "import { NameService } from '../../shared/src/index';\nexport function freshEntry() { return new NameService(); }\n");
  const input = { ...inputFor(name), refresh: true };
  if ('symbol' in input) input.symbol = 'freshEntry';
  if ('entry' in input) input.entry = 'freshEntry';
  const result = await createScriptPilot(dispatch, budget).run(`return await tools.${name}(${JSON.stringify(input)});`, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts[0]?.result.content).toContain('freshEntry');
  expect(result.receipts[0]?.result.content).toContain('packages/app');
  expect(result.receipts[0]?.input).toEqual(input);
  const baseline = await executeTool(name, { ...input, refresh: false }, ctx);
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(result.value).toEqual(result.receipts[0]?.result);
  expect(budget.spentBudget).toBe(1);
}, 30_000);

it.each(relations)('preserves %s warming and unavailable recovery without hidden retries', async name => {
  const { ctx, budget, dispatch } = await fixture(2);
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', '250');
  const method = name === 'module_context' ? 'getModuleContext' : name === 'process_context' ? 'getProcessContext'
    : name === 'impact_estimate' ? 'getImpactEstimate' : 'getSymbolContext';
  const delayed = vi.spyOn(repoWorker, method).mockImplementation(() => new Promise<never>(() => {}));
  const baseline = await executeTool(name, inputFor(name), ctx);
  const pilot = createScriptPilot(dispatch, budget);
  const warming = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(warming.receipts[0]?.result.content).toBe(baseline);
  expect(warming.receipts[0]?.result.content).toContain('still warming');
  expect(delayed).toHaveBeenCalledTimes(2);
  if (name === 'relationship_scan') expect(warming.receipts[0]?.result.content).not.toContain('No direct callers found');
  delayed.mockRestore();
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', '10000');
  const recovered = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(recovered.hadToolErrors, recovered.error).toBe(false);
  expect(recovered.receipts[0]?.result.content).toContain('packages/app');
  expect(recovered.receipts[0]?.result.content).not.toContain('still warming');
  expect(budget.spentBudget).toBe(2);
}, 30_000);

it.each([2, 4])('charges relationship scan internals once under parent budget %i', async total => {
  const { ctx, budget, dispatch } = await fixture(total);
  const nativeBudget = { ...budget };
  const native = wrapCodingToolAsRunnable(getToolDefinition('relationship_scan')!,
    (input, context) => executeTool('relationship_scan', input, context), ctx, nativeBudget);
  for (let i = 0; i < total; i++) await native.execute(inputFor('relationship_scan'), { agent: { name: 'fixture', instructions: '' } });
  const result = await createScriptPilot(dispatch, budget).run(`
    for (let i=0; i<${total + 1}; i++) await tools.relationship_scan(${JSON.stringify(inputFor('relationship_scan'))});
  `, limits);
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
}, 30_000);

it.each(relations.filter(name => name !== 'module_context'))('recovers from an admitted %s argument error in one cell', async name => {
  const { ctx, budget, dispatch } = await fixture(2);
  const baseline = await executeTool(name, {}, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`
    const invalid = await tools.${name}({});
    if (!invalid.isError) throw new Error('Expected required-target refusal');
    return await tools.${name}(${JSON.stringify(inputFor(name))});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(result.receipts[0]?.input).toEqual({});
  expect(result.receipts[1]?.result.content).toContain('packages/app');
  expect(budget.spentBudget).toBe(2);
}, 30_000);

it('retains the complete native overview receipt when a small guest transfer limit fails', async () => {
  const { ctx, budget, dispatch } = await fixture();
  const baseline = await executeTool('repo_overview', {}, ctx);
  const result = await createScriptPilot(dispatch, budget).run('return await tools.repo_overview({});',
    { ...limits, maxTransferBytes: 512 });
  expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('transfer limit') });
  expect(result.receipts).toHaveLength(1);
  expect(stable(result.receipts[0]?.result.content)).toBe(stable(baseline));
  expect(budget.spentBudget).toBe(1);
});

it.each(names)('respects Agent, explicit exclusions and live revocation of %s', async name => {
  const { ctx, budget, dispatch } = await fixture();
  ctx.workMode = 'agent';
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
  ctx.workMode = 'coding';
  ctx.excludeTools = [name];
  expect(createScriptPilot(dispatch, budget).tools.map(tool => tool.name)).not.toContain(name);
  ctx.excludeTools = [];
  const pilot = createScriptPilot(dispatch, budget);
  dispatch.activeToolNames.splice(dispatch.activeToolNames.indexOf(name), 1);
  const result = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(result.receipts[0]?.result.content).toContain('outside this Script pilot');
  expect(budget.spentBudget).toBe(0);
});

it.each(names)('drains admitted %s work and preserves its result on cancellation without dispatching another leaf', async name => {
  const { ctx, budget, dispatch } = await fixture();
  // Warm the shared worker before comparing cancellation at the tool admission boundary.
  await executeTool(name, inputFor(name), ctx);
  const nativeController = new AbortController();
  const baseline = await runToolDispatch({ ...dispatch, abortSignal: nativeController.signal,
    events: { onToolExecutionStart: () => nativeController.abort() },
    toolBlocks: [{ type: 'tool_use', id: 'native-cancelled', name, input: inputFor(name) }] });
  const controller = new AbortController();
  const ended = vi.fn();
  const admitted = vi.fn(() => controller.abort());
  const pilot = createScriptPilot({ ...dispatch, abortSignal: controller.signal,
    events: { onToolExecutionStart: admitted, onToolExecutionEnd: ended } }, budget);
  const result = await pilot.run(`await tools.${name}(${JSON.stringify(inputFor(name))}); await tools.repo_overview({});`, limits);
  expect(result.status).toBe('cancelled');
  expect(result.receipts).toHaveLength(1);
  expect(stable(result.receipts[0]?.result.content)).toBe(stable(baseline.get('native-cancelled')));
  expect(ended).toHaveBeenCalledOnce();
  expect(admitted).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
  expect(await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits)).toMatchObject({ status: 'cancelled', receipts: [] });
  expect(budget.spentBudget).toBe(1);
}, 30_000);

it('persists an overview-to-symbol-to-cycle investigation in one parent Run cell with three native-equivalent calls', async () => {
  const { root, ctx, budget } = await fixture(3);
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-repo-'));
  directories.push(storageRoot);
  vi.stubEnv('KODAX_HOME', storageRoot);
  const storage = new FileSessionStorage({ sessionsDir: path.join(storageRoot, 'sessions'), configHome: storageRoot, cwd: root });
  const baseline = await executeTool('cyclic_dependencies', {}, ctx);
  const admitted: string[] = [];
  await withHostInvocation({ provider: 'unconfigured-provider', lsp: false,
    session: { id: 'repo-session', storage },
    context: { executionCwd: root, gitRoot: root, runtimeRunId: 'repo-run', managedWorkBudget: budget },
    events: { onToolExecutionStart: call => { admitted.push(call.name); } },
  }, 'Investigate the two-package fixture', parent => withScriptCells(parent, limits, async runCell => {
    const result = await runCell(`
      const overview = await tools.repo_overview({});
      if (overview.isError || !overview.content.includes('packages/shared')) throw new Error('Missing repository evidence');
      const symbol = await tools.semantic_lookup({query:'NameService', kind:'symbol', limit:1});
      if (symbol.isError || !symbol.content.includes('packages/shared/src/index.ts')) throw new Error('Missing symbol evidence');
      return await tools.cyclic_dependencies({});
    `);
    expect(result.status, result.error).toBe('completed');
    expect(result.hadToolErrors).toBe(false);
    expect(result.receipts.map(receipt => receipt.name)).toEqual(names.slice(0, 3));
    expect(result.receipts[2]?.result.content).toBe(baseline);
    expect(result.receipts[2]?.result.content).toContain('1 cycle(s) found');
  }));
  expect(admitted).toEqual(names.slice(0, 3));
  expect(budget.spentBudget).toBe(3);
  const records = (await storage.load('repo-session'))?.extensionRecords ?? [];
  expect(records.filter(record => record.type === 'call.settled')).toHaveLength(3);
  expect(records.filter(record => record.type === 'call.settled')[2]?.data).toMatchObject({ runId: 'repo-run', data: {
    name: 'cyclic_dependencies', input: {}, result: { content: baseline, isError: false },
  } });
  expect(records.at(-1)?.data).toMatchObject({ data: { status: 'completed', spentBudget: 3 } });
}, 30_000);
