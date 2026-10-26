import { afterAll, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { RunnableTool } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { buildToolExecutionContext } from './tool-execution-context.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../task-engine/_internal/managed-task/llm-adapter.js';
import { LspService, shutdownDefaultLspService } from '../lsp/service.js';
import { executeTool, getRegisteredToolDefinition, listToolDefinitions, registerTool } from '../tools/index.js';
import { getBuiltinToolDefinition, KODAX_TOOLS } from '../tools/registry.js';
import { buildWorkerStableInstructions } from '../agents/worker-role-prompt.js';
import type { KodaXManagedWorkBudget, KodaXOptions } from '../types.js';

afterAll(() => shutdownDefaultLspService());

it('keeps internal work-surface metadata out of every public model-tool definition export', () => {
  for (const tool of [...KODAX_TOOLS, ...listToolDefinitions()]) {
    expect(tool).not.toHaveProperty('workSurface');
    expect(getBuiltinToolDefinition(tool.name)).not.toHaveProperty('workSurface');
  }
});

const specialized = [
  'repo_overview', 'changed_scope', 'changed_diff', 'semantic_lookup',
  'cyclic_dependencies', 'relationship_scan', 'module_context', 'symbol_context',
  'process_context', 'impact_estimate', 'lsp_definition', 'lsp_references',
  'lsp_hover', 'lsp_implementation', 'lsp_document_symbols', 'lsp_workspace_symbols',
  'lsp_incoming_calls', 'lsp_outgoing_calls',
];

function assembly(options: Partial<KodaXOptions> = {}) {
  const ctx = buildToolExecutionContext({ options: { provider: 'offline-fixture', ...options },
    runtime: options.extensionRuntime, managedProtocolPayloadRef: { current: undefined } });
  return { ctx, worker: buildRunnerAgentChain(ctx).worker };
}

async function menu(options: Partial<KodaXOptions> = {}) {
  const { worker } = assembly(options);
  let tools: readonly KodaXToolDefinition[] = [];
  await buildRunnerLlmAdapter({ provider: 'offline-fixture', ...options }, async (_messages, sent) => {
    tools = sent;
    return { textBlocks: [{ text: 'Offline fixture.' }], toolBlocks: [] };
  })([{ role: 'user', content: 'Inspect the supplied document.' }], worker);
  return tools;
}

it('keeps Coding wire contracts unchanged and removes only the 18 specialist entries from Agent', async () => {
  const baseline = await menu();
  expect(await menu({ workMode: 'coding' })).toEqual(baseline);
  expect(baseline.filter(tool => specialized.includes(tool.name))).toHaveLength(18);
  const agent = await menu({ workMode: 'agent' });
  expect(agent).toEqual(baseline.filter(tool => !specialized.includes(tool.name)));
  expect(agent.some(tool => 'workSurface' in tool)).toBe(false);
  expect(agent.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'read', 'write', 'edit', 'bash', 'grep', 'glob', 'undo', 'insert_after_anchor',
    'ask_user_question', 'exit_plan_mode', 'todo_create', 'todo_update', 'todo_list',
    'create_goal', 'get_goal', 'update_goal', 'tool_search', 'tool_call',
  ]));
});

it('preserves SDK profiles, custom declarations and specialist children instead of inheriting the root preset', async () => {
  const contexts: NonNullable<KodaXOptions['context']>[] = [
    { agentProfile: { id: 'partner', instructions: 'Caller-owned contract.' } },
    { currentAgentId: '/root/explorer', excludeTools: ['write', 'edit'] },
    { systemPromptOverride: 'Caller-owned standalone agent.' },
    { toolVisibilityPolicy: ({ name }) => ['read', 'lsp_definition'].includes(name) },
  ];
  for (const context of contexts) {
    expect(await menu({ workMode: 'agent', context })).toEqual(await menu({ context }));
  }
});

it('keeps discovery and bridge consistent without deleting underlying SDK or provider capabilities', async () => {
  const service = new LspService({ servers: [] });
  const definition = vi.spyOn(service, 'getDefinition').mockResolvedValue('SDK compiler evidence');
  const { ctx } = assembly({ workMode: 'agent', context: { lspService: service } });
  const permission = vi.fn(async () => true);
  const budget: KodaXManagedWorkBudget = { totalBudget: 5, spentBudget: 0, currentHarness: 'H0_DIRECT' };
  const worker = buildRunnerAgentChain(ctx, undefined, budget, undefined, undefined, { beforeToolExecute: permission }).worker;
  const hidden = [...specialized, 'changed_diff_bundle', 'lsp_prepare_call_hierarchy'];
  expect(await executeTool('tool_search', { query: `select:${hidden.join(',')}` }, ctx)).not.toContain('<function>');
  expect(await executeTool('tool_search', { query: 'select:read,grep,glob' }, ctx)).toContain('"name":"grep"');
  const bridge = worker.tools?.find(tool => tool.name === 'tool_call') as RunnableTool;
  const rejected = await bridge.execute({ name: 'lsp_definition', input: { path: 'file.ts', line: 1 } }, { agent: worker });
  expect(rejected.isError).toBe(true);
  expect(rejected.content).toContain('not active');
  expect(definition).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
  expect(budget.spentBudget).toBe(1);
  const recovered = await bridge.execute({ name: 'read', input: { path: fileURLToPath(import.meta.url), limit: 1 } }, { agent: worker });
  expect(recovered.isError).not.toBe(true);
  expect(recovered.content).toContain('import { afterAll');
  expect(permission).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(2);
  expect(await executeTool('lsp_definition', { path: 'file.ts', line: 1 }, ctx)).toBe('SDK compiler evidence');
  expect(definition).toHaveBeenCalledOnce();
  expect(listToolDefinitions().map(tool => tool.name)).toEqual(expect.arrayContaining(hidden));
});

it('preserves extension-owned replacements even when they reuse a builtin name and its metadata', async () => {
  const builtin = getRegisteredToolDefinition('lsp_definition');
  if (!builtin) throw new Error('Missing LSP registration');
  const unregister = registerTool({ ...builtin, description: 'Host-owned reference lookup.', handler: async () => 'Host evidence' });
  try {
    const { ctx, worker } = assembly({ workMode: 'agent' });
    expect((await menu({ workMode: 'agent' })).find(tool => tool.name === 'lsp_definition')?.description)
      .toBe('Host-owned reference lookup.');
    expect(await executeTool('tool_search', { query: 'select:lsp_definition' }, ctx)).toContain('Host-owned reference lookup');
    const bridge = worker.tools?.find(tool => tool.name === 'tool_call') as RunnableTool;
    expect((await bridge.execute({ name: 'lsp_definition', input: { path: 'x.ts', line: 1 } }, { agent: worker })).content).toBe('Host evidence');
  } finally { unregister(); }
});

it('retains AMA planning, collaboration and completion instructions across the two work surfaces', async () => {
  const coding = assembly({ agentMode: 'ama' });
  const agent = assembly({ agentMode: 'ama', workMode: 'agent' });
  try {
    const baseline = buildWorkerStableInstructions(coding.worker.tools?.map(tool => tool.name));
    const candidate = buildWorkerStableInstructions(agent.worker.tools?.map(tool => tool.name));
    const common = baseline.split('\n\n').filter(section => !specialized.some(name => section.includes(name)));
    expect(common.some(section => section.includes('PLAN-FIRST GUIDANCE:'))).toBe(true);
    expect(common.some(section => section.includes('spawn_agent'))).toBe(true);
    for (const section of common) expect(candidate).toContain(section);
    expect(agent.worker.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'agent_output',
    ]));
  } finally {
    await coding.ctx.actorHost?.close();
    await agent.ctx.actorHost?.close();
  }
});

it('does not silently accept unknown modes', () => {
  expect(() => assembly({ workMode: 'unknown' as KodaXOptions['workMode'] })).toThrow('Unsupported work mode');
});
