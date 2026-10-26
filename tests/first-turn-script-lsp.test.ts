import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { LspService } from '../packages/coding/src/lsp/service.js';
import { executeTool, getToolDefinition } from '../packages/coding/src/tools/index.js';
import { projectModelToolDefinition } from '../packages/coding/src/tools/model-tool-definition.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';

const cases = [
  ['lsp_definition', 'getDefinition'], ['lsp_hover', 'getHover'], ['lsp_references', 'getReferences'],
  ['lsp_document_symbols', 'getDocumentSymbols'], ['lsp_workspace_symbols', 'getWorkspaceSymbols'],
  ['lsp_implementation', 'getImplementation'], ['lsp_incoming_calls', 'getIncomingCalls'], ['lsp_outgoing_calls', 'getOutgoingCalls'],
] as const;
const names = cases.map(([name]) => name);
const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 12, maxTransferBytes: 64 * 1024 };
const services: LspService[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.shutdownAll();
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-lsp-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

function fixture(totalBudget = 12) {
  const service = new LspService({ servers: [] });
  services.push(service);
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: process.cwd(), gitRoot: process.cwd(), lspService: service };
  const budget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames: [...names] as string[], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: names, modelSelection: {} }) };
  return { service, ctx, budget, dispatch };
}

function inputFor(name: string): Record<string, unknown> {
  return name === 'lsp_workspace_symbols' ? { query: '运行' }
    : name === 'lsp_document_symbols' ? { path: 'src/中文 file.ts' }
      : { path: 'src/中文 file.ts', line: 3, column: 5 };
}

it('preserves all eight native navigation contracts and complete bound-service output', async () => {
  const { service, ctx, budget, dispatch } = fixture();
  dispatch.activeToolNames.push('lsp_prepare_call_hierarchy');
  const pilot = createScriptPilot(dispatch, budget);
  expect(pilot.tools.map(tool => tool.name)).toEqual(names);
  const nativeBudget = { ...budget };
  for (const [name, method] of cases) {
    const evidence = `${name}: src/中文 file.ts:3:5\n${'typed evidence\n'.repeat(80)}[Server output truncated; refine query]`;
    const call = vi.spyOn(service, method).mockResolvedValue(evidence);
    const definition = getToolDefinition(name)!;
    expect(pilot.tools.find(tool => tool.name === name)).toEqual(projectModelToolDefinition(definition, { kind: 'builtin' }));
    const native = wrapCodingToolAsRunnable(definition, (input, context) => executeTool(name, input, context), ctx, nativeBudget);
    const baseline = await native.execute(inputFor(name), { agent: { name: 'fixture', instructions: '' } });
    const result = await pilot.run(`return await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.receipts[0]?.result.content).toBe(evidence);
    expect(result.receipts[0]?.result.content).toBe(baseline.content);
    expect(result.value).toEqual(result.receipts[0]?.result);
    expect(result.receipts[0]?.input).toEqual(inputFor(name));
    expect(call).toHaveBeenCalledTimes(2);
    const args = call.mock.calls[1]!;
    expect(args[0]).toBe(name === 'lsp_workspace_symbols' ? '运行' : path.resolve('src/中文 file.ts'));
    if (!['lsp_workspace_symbols', 'lsp_document_symbols'].includes(name)) expect(args[1]).toEqual({ line: 2, character: 4 });
    expect(args.at(-1)).toMatchObject({ gitRoot: process.cwd(), signal: expect.any(AbortSignal) });
  }
  expect(budget.spentBudget).toBe(8);
  expect(nativeBudget.spentBudget).toBe(8);
});

it('distinguishes lazy services, explicit disablement, host bindings and live revocation', async () => {
  const { service, ctx, budget, dispatch } = fixture();
  // No language server has started; an idle service remains a valid capability.
  expect(createScriptPilot(dispatch, budget).tools.map(tool => tool.name)).toEqual(names);
  ctx.lspService = undefined;
  ctx.lspNavigationDisabled = true;
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
  ctx.lspService = service;
  expect(createScriptPilot(dispatch, budget).tools.map(tool => tool.name)).toEqual(names);
  const pilot = createScriptPilot(dispatch, budget);
  ctx.lspService = undefined;
  const result = await pilot.run('return await tools.lsp_definition({path:"a.ts", line:1});', limits);
  expect(result.receipts[0]?.result.content).toContain('outside this Script pilot');
  expect(budget.spentBudget).toBe(0);
  ctx.lspService = service;
  ctx.workMode = 'agent';
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
  ctx.workMode = 'coding';
  ctx.excludeTools = [...names];
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
});

it.each(cases)('%s preserves policy refusal and recovers in one cell without charging denial', async (name, method) => {
  const { service, budget, dispatch } = fixture(1);
  const call = vi.spyOn(service, method).mockResolvedValue('Permitted navigation');
  let attempts = 0;
  const events = { beforeToolExecute: vi.fn(async () => ++attempts <= 2 ? '[Blocked] Read policy' : true) };
  const baseline = await runToolDispatch({ ...dispatch, events, abortSignal: undefined,
    toolBlocks: [{ type: 'tool_use', id: 'native-denied', name, input: inputFor(name) }] });
  const result = await createScriptPilot({ ...dispatch, events }, budget).run(`
    const denied = await tools.${name}(${JSON.stringify(inputFor(name))});
    if (!denied.isError) throw new Error('Expected permission refusal');
    return await tools.${name}(${JSON.stringify(inputFor(name))});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.result.content).toBe(baseline.get('native-denied'));
  expect(result.receipts[1]?.result.content).toBe('Permitted navigation');
  expect(call).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it.each(cases)('%s retains service failure then recovery and does not replay the failed request', async (name, method) => {
  const { service, budget, dispatch } = fixture(2);
  const call = vi.spyOn(service, method).mockRejectedValueOnce(new Error('Fixture server disconnected')).mockResolvedValue('Recovered evidence');
  const result = await createScriptPilot(dispatch, budget).run(`
    const failed = await tools.${name}(${JSON.stringify(inputFor(name))});
    if (!failed.isError) throw new Error('Expected service failure');
    return await tools.${name}(${JSON.stringify(inputFor(name))});
  `, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.result.content).toContain('Fixture server disconnected');
  expect(result.receipts[1]?.result.content).toBe('Recovered evidence');
  expect(call).toHaveBeenCalledTimes(2);
  expect(budget.spentBudget).toBe(2);
});

it.each(cases)('%s forwards cancellation, drains the admitted service call and blocks the next leaf', async (name, method) => {
  const { service, budget, dispatch } = fixture();
  const controller = new AbortController();
  const call = vi.spyOn(service, method).mockImplementation(async (...args: unknown[]) => {
    const request = args.at(-1) as { signal: AbortSignal };
    const stopped = new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    controller.abort();
    await stopped;
    return '[LSP cancelled after admission]';
  });
  const ended = vi.fn();
  const pilot = createScriptPilot({ ...dispatch, abortSignal: controller.signal, events: { onToolExecutionEnd: ended } }, budget);
  const result = await pilot.run(`await tools.${name}(${JSON.stringify(inputFor(name))}); await tools.${name}(${JSON.stringify(inputFor(name))});`, limits);
  expect(result.status).toBe('cancelled');
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.result.content).toBe('[LSP cancelled after admission]');
  expect(ended).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
  expect(await pilot.run('return 1;', limits)).toMatchObject({ status: 'cancelled', receipts: [] });
});

it.each([2, 4])('uses the same %i budget units as native navigation', async total => {
  const { service, ctx, budget, dispatch } = fixture(total);
  const call = vi.spyOn(service, 'getDefinition').mockResolvedValue('Definition evidence');
  const nativeBudget = { ...budget };
  const native = wrapCodingToolAsRunnable(getToolDefinition('lsp_definition')!,
    (input, context) => executeTool('lsp_definition', input, context), ctx, nativeBudget);
  for (let i = 0; i < total; i++) await native.execute(inputFor('lsp_definition'), { agent: { name: 'fixture', instructions: '' } });
  const result = await createScriptPilot(dispatch, budget).run(`
    for (let i=0; i<${total + 1}; i++) await tools.lsp_definition(${JSON.stringify(inputFor('lsp_definition'))});
  `, limits);
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
  expect(call).toHaveBeenCalledTimes(total * 2);
});

it('preserves native invalid-position feedback before recovering without rewriting parameters', async () => {
  const { service, ctx, budget, dispatch } = fixture(2);
  const call = vi.spyOn(service, 'getDefinition').mockResolvedValue('Definition evidence');
  const invalid = { path: 'a.ts', line: 0 };
  const baseline = await executeTool('lsp_definition', invalid, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`
    const denied = await tools.lsp_definition(${JSON.stringify(invalid)});
    if (!denied.isError) throw new Error('Expected invalid position');
    return await tools.lsp_definition({path:'a.ts', line:1});
  `, limits);
  expect(result.receipts[0]?.input).toEqual(invalid);
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(call).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(2);
});

it('runs all navigation through a real local JSON-RPC server without an extra prepare call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-lsp-'));
  directories.push(root);
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'main.ts'), 'const x = 1;\n');
  const serverFile = fileURLToPath(new URL('../packages/coding/src/lsp/fake-lsp-server.fixture.mjs', import.meta.url));
  const { ctx, budget, dispatch } = fixture(8);
  const service = new LspService({ servers: [{ id: 'script-fixture', languageIds: ['typescript'], rootMarkers: ['package.json'],
    discover: () => ({ command: process.execPath, args: [serverFile] }), installGuidance: 'local fixture' }], documentTimeoutMs: 4000 });
  services.push(service);
  ctx.lspService = service;
  ctx.executionCwd = root;
  ctx.gitRoot = root;
  const pilot = createScriptPilot(dispatch, budget);
  for (const [name] of cases) {
    const input = name === 'lsp_workspace_symbols' ? { query: 'x' } : { path: 'main.ts', line: 1, character: 1 };
    const baseline = await executeTool(name, input, ctx);
    const result = await pilot.run(`return await tools.${name}(${JSON.stringify(input)});`, limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]?.result.content).toBe(baseline);
    expect(result.receipts[0]?.result.isError).toBe(false);
    expect(result.value).toEqual(result.receipts[0]?.result);
    if (name === 'lsp_hover') expect(result.receipts[0]?.result.content).toContain('const x: number');
    if (name === 'lsp_incoming_calls') expect(result.receipts[0]?.result.content).toContain('entry');
    if (name === 'lsp_outgoing_calls') expect(result.receipts[0]?.result.content).toContain('save');
  }
  expect(budget.spentBudget).toBe(8);
}, 30_000);
