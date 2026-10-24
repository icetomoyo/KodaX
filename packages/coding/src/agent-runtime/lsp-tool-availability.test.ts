import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Runner, type RunnableTool } from '@kodax-ai/agent';
import { runWithScopedConfig, type KodaXToolDefinition } from '@kodax-ai/llm';
import { buildToolExecutionContext } from './tool-execution-context.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../task-engine/_internal/managed-task/llm-adapter.js';
import { executeTool, registerTool } from '../tools/index.js';
import { LspService, shutdownDefaultLspService } from '../lsp/service.js';
import { getToolExecutionOverride } from './permission-gate.js';
import type { KodaXManagedWorkBudget, KodaXToolExecutionContext } from '../types.js';

const navigationNames = [
  'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols',
  'lsp_workspace_symbols', 'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls',
  'lsp_prepare_call_hierarchy',
];

afterEach(() => vi.unstubAllEnvs());
afterAll(() => shutdownDefaultLspService());

function context(lsp?: boolean, lspService?: LspService) {
  return runWithScopedConfig({ lsp }, () => buildToolExecutionContext({
    options: { provider: 'offline-fixture', lsp, context: { lspService } },
    runtime: undefined, managedProtocolPayloadRef: { current: undefined },
  }));
}

function runnable(tools: readonly KodaXToolDefinition[] | undefined, name: string): RunnableTool {
  const tool = tools?.find(candidate => candidate.name === name);
  if (!tool || !('execute' in tool) || typeof tool.execute !== 'function') throw new Error(`Missing runnable ${name}`);
  return tool as RunnableTool;
}

it('omits disabled unbound LSP from the native menu, discovery and bridge without executing it', async () => {
  const ctx = context(false);
  expect(ctx.lspService).toBeUndefined();
  const budget: KodaXManagedWorkBudget = { totalBudget: 100, spentBudget: 0, currentHarness: 'H0_DIRECT' };
  const permission = vi.fn(async () => true);
  const worker = buildRunnerAgentChain(ctx, undefined, budget, undefined, undefined, { beforeToolExecute: permission }).worker;
  let menu: readonly KodaXToolDefinition[] = [];
  await buildRunnerLlmAdapter({ provider: 'offline-fixture' }, async (_messages, tools) => {
    menu = tools;
    return { textBlocks: [{ text: 'Offline fixture.' }], toolBlocks: [] };
  })([{ role: 'user', content: 'Inspect.' }], worker);
  expect(menu.filter(tool => navigationNames.includes(tool.name))).toEqual([]);
  const discovered = await executeTool('tool_search', { query: `select:${navigationNames.join(',')}` }, ctx);
  expect(discovered).not.toContain('<function>');
  const bridge = runnable(worker.tools, 'tool_call');
  const refused = await bridge.execute({ name: 'lsp_definition', input: { path: 'file.ts', line: 1 } }, { agent: worker });
  expect(refused.isError).toBe(true);
  expect(refused.content).toContain('not active');
  expect(permission).not.toHaveBeenCalled();
  expect(budget.spentBudget).toBe(1);
  const recovered = await bridge.execute({ name: 'read', input: { path: fileURLToPath(import.meta.url), limit: 1 } }, { agent: worker });
  expect(recovered.isError).not.toBe(true);
  expect(recovered.content).toContain('import { afterAll');
  expect(permission).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(2);
});

it('snapshots env disablement but restores all navigation on the next enabled assembly', async () => {
  vi.stubEnv('KODAX_LSP', '0');
  const disabled = context();
  const enabled = context(true); // Explicit per-run enable wins over the env.
  expect(disabled.lspService).toBeUndefined();
  expect(enabled.lspService).toBeDefined(); // No server process needs to start.
  vi.stubEnv('KODAX_LSP', '1');
  for (const [ctx, available] of [[disabled, false], [enabled, true], [context(), true]] as const) {
    const worker = buildRunnerAgentChain(ctx).worker;
    expect(worker.tools!.filter(tool => navigationNames.includes(tool.name))).toHaveLength(available ? 9 : 0);
    const result = await executeTool('tool_search', { query: 'select:lsp_definition' }, ctx);
    expect(String(result).includes('"name":"lsp_definition"')).toBe(available);
  }
});

it.each([false, true])('preserves an injected service even when defaults were disabled (late=%s)', async late => {
  vi.stubEnv('KODAX_LSP', '0');
  const service = new LspService({ servers: [] });
  const invoke = vi.spyOn(service, 'getDefinition').mockResolvedValue('Injected definition');
  const ctx = late ? { ...context(false), lspService: service } : context(false, service);
  const worker = buildRunnerAgentChain(ctx).worker;
  const native = runnable(worker.tools, 'lsp_definition');
  expect(native).toBeDefined();
  const discovery = await executeTool('tool_search', { query: 'select:lsp_definition' }, ctx);
  expect(discovery).toContain('"name":"lsp_definition"');
  const input = { path: 'file.ts', line: 2 };
  const direct = await native.execute(input, { agent: worker });
  const bridged = await runnable(worker.tools, 'tool_call').execute({ name: native.name, input }, { agent: worker });
  expect(direct.content).toBe('Injected definition');
  expect(bridged.content).toBe(direct.content);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('keeps raw SDK inventory and handlers intact without inferring disablement from an absent binding', async () => {
  const ctx: KodaXToolExecutionContext = { backups: new Map() };
  expect(await executeTool('tool_search', { query: 'select:lsp_prepare_call_hierarchy,lsp_definition' }, ctx))
    .toContain('"name":"lsp_prepare_call_hierarchy"');
  expect(await executeTool('lsp_definition', { path: 'file.ts', line: 1 }, context(false)))
    .toContain('LSP is unavailable');
});

it('does not hide an extension-owned replacement for a builtin LSP name', async () => {
  const unregister = registerTool({ name: 'lsp_definition', description: 'Host compiler navigation.',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', toClassifierInput: () => '',
    handler: async () => 'Host compiler evidence' });
  try {
    const ctx = context(false);
    const worker = buildRunnerAgentChain(ctx).worker;
    expect(worker.tools!.some(tool => tool.name === 'lsp_definition')).toBe(true);
    expect(await executeTool('tool_search', { query: 'select:lsp_definition' }, ctx)).toContain('Host compiler navigation');
    const result = await runnable(worker.tools, 'tool_call').execute({ name: 'lsp_definition', input: {} }, { agent: worker });
    expect(result.content).toBe('Host compiler evidence');
  } finally { unregister(); }
});

it.each([false, true])('keeps injected LSP permission rejection and recovery single-charged (bridge=%s)', async bridged => {
  const service = new LspService({ servers: [] });
  const invoke = vi.spyOn(service, 'getDefinition').mockResolvedValue('Recovered definition');
  const ctx = context(false, service);
  let permissionCalls = 0;
  const events = { beforeToolExecute: async (name: string) => name !== 'lsp_definition' || permissionCalls++ > 0
    ? true : '[Tool Error] fixture permission denied' };
  const budget: KodaXManagedWorkBudget = { totalBudget: 100, spentBudget: 0, currentHarness: 'H0_DIRECT' };
  const worker = buildRunnerAgentChain(ctx, undefined, budget, undefined, undefined, events).worker;
  let round = 0;
  const result = await Runner.run(worker, 'Offline permission recovery.', {
    tracer: null,
    toolObserver: { beforeTool: async call => (await getToolExecutionOverride(events, call.name, call.input, call.id)) ?? true },
    llm: async messages => {
      if (round === 1) { expect(budget.spentBudget).toBe(0); expect(JSON.stringify(messages.at(-1))).toContain('fixture permission denied'); }
      if (round === 2) { expect(budget.spentBudget).toBe(1); expect(JSON.stringify(messages.at(-1))).toContain('Recovered definition'); }
      const input = { path: 'file.ts', line: 1 };
      return round++ < 2 ? { text: '', toolCalls: [{ id: `step-${round}`, name: bridged ? 'tool_call' : 'lsp_definition',
        input: bridged ? { name: 'lsp_definition', input } : input }] } : { text: 'Done' };
    },
  });
  expect(result.output).toBe('Done');
  expect(round).toBe(3);
  expect(permissionCalls).toBe(2);
  expect(invoke).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it('keeps a role visibility restriction effective even with an injected service', async () => {
  const ctx = { ...context(false, new LspService({ servers: [] })),
    toolVisibilityPolicy: ({ name }: { name: string }) => name !== 'lsp_definition' };
  const worker = buildRunnerAgentChain(ctx).worker;
  expect(worker.tools!.some(tool => tool.name === 'lsp_definition')).toBe(false);
  expect(await executeTool('tool_search', { query: 'select:lsp_definition' }, ctx)).not.toContain('<function>');
  const refused = await runnable(worker.tools, 'tool_call').execute({ name: 'lsp_definition', input: { path: 'file.ts', line: 1 } }, { agent: worker });
  expect(refused.isError).toBe(true);
  expect(refused.content).toContain('not active');
});
