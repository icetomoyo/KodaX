import { afterAll, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '@kodax-ai/agent';
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
import { executeToolCall } from './tool-dispatch.js';
import { buildRuntimeSessionState } from './runtime-session-state.js';
import type { ExtensionRuntimeContract, RunScopedToolDefinition } from '../extensions/runtime-contract.js';

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
    { currentAgentId: '/root/expert', workModePolicy: 'intersect', agentProfile: { id: 'expert' }, excludeTools: ['write', 'edit'] },
    { systemPromptOverride: 'Caller-owned standalone agent.' },
    { toolVisibilityPolicy: ({ name }) => ['read', 'lsp_definition'].includes(name) },
  ];
  for (const context of contexts) {
    expect(await menu({ workMode: 'agent', context })).toEqual(await menu({ context }));
  }
});

it('opts a Partner profile into Agent by intersecting its existing tool ceiling', async () => {
  const context = {
    agentProfile: { id: 'partner', instructions: 'Caller-owned contract.' },
    systemPromptOverride: 'Partner system instructions.',
    workModePolicy: 'intersect' as const,
    toolVisibilityPolicy: ({ name }: { name: string }) => !['bash', 'write', 'edit', 'spawn_agent'].includes(name),
  };
  const tools = await menu({ workMode: 'agent', context });
  expect(tools.map(tool => tool.name)).not.toContain('repo_overview');
  expect(tools.map(tool => tool.name)).not.toContain('bash');
  expect(tools.map(tool => tool.name)).toContain('read');
  const { ctx } = assembly({ workMode: 'agent', context });
  expect(ctx.workMode).toBe('agent');
  expect(ctx.agentProfile).toBe(context.agentProfile);
  expect(ctx.toolVisibilityPolicy).toBe(context.toolVisibilityPolicy);
});

it('keeps allowed Partner Skills, research, connectors, Artifacts and expert tools behind existing authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-partner-mode-'));
  try {
    const skillDirectory = join(directory, 'skills', 'partner-research');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: partner-research\ndescription: Research guidance\n---\nCite the primary evidence.');
    const skillRegistry = new SkillRegistry(directory, { projectPaths: [join(directory, 'skills')],
      userPaths: [], pluginPaths: [], builtinPath: join(directory, 'builtin') });
    await skillRegistry.discover();
    const hostNames = ['space_connector_search', 'space_artifact_create', 'space_expert_verify'];
    const runTools: RunScopedToolDefinition[] = [...hostNames, 'space_forbidden'].map(name => ({
      name, description: `Partner ${name}`, inputSchema: { type: 'object', properties: {} },
      capabilityId: `host:partner:${name}`, sideEffect: 'mutates-state', planModeAllowed: false,
    }));
    const executeCapability = vi.fn<ExtensionRuntimeContract['executeCapability']>(async (_provider, id) => ({
      kind: 'tool', content: `completed:${id}`,
    }));
    const runtime = { listRunTools: () => runTools, executeCapability } as Partial<ExtensionRuntimeContract> as ExtensionRuntimeContract;
    const childTools = ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'agent_output'];
    const forbidden = [...specialized, 'changed_diff_bundle', 'lsp_prepare_call_hierarchy',
      'bash', 'write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo', ...childTools, 'grep', 'space_forbidden'];
    const options: KodaXOptions = { provider: 'offline-fixture', workMode: 'agent', extensionRuntime: runtime,
      skillDynamicContext: { disable: true }, context: { executionCwd: directory, skillRegistry,
        agentProfile: { id: 'partner', instructions: 'Keep the Partner contract.' }, workModePolicy: 'intersect',
        excludeTools: ['grep'], toolVisibilityPolicy: tool => !childTools.includes(tool.name)
          && tool.name !== 'space_forbidden' && !['mutates-fs', 'mutates-shell'].includes(tool.sideEffect),
      } };
    const { ctx } = assembly(options);
    const allowed = ['skill', 'web_search', ...hostNames];
    const wireNames = (await menu(options)).map(tool => tool.name);
    expect(wireNames).toEqual(expect.arrayContaining(allowed));
    for (const name of forbidden) expect(wireNames).not.toContain(name);
    expect(await executeTool('tool_search', { query: `select:${forbidden.join(',')}` }, ctx)).not.toContain('<function>');
    for (const name of allowed) {
      expect(await executeTool('tool_search', { query: `select:${name}` }, ctx)).toContain(`"name":"${name}"`);
    }
    const beforeToolExecute = vi.fn(async (_name: string): Promise<string | undefined> => undefined);
    const worker = buildRunnerAgentChain(ctx, undefined, undefined, undefined, undefined, { beforeToolExecute }).worker;
    const bridge = worker.tools!.find(tool => tool.name === 'tool_call') as RunnableTool;
    const active = [...wireNames, ...forbidden]; // A caller's stale inventory cannot grant authority.
    const state = buildRuntimeSessionState({ activeTools: active, modelSelection: {} });
    for (const name of forbidden) {
      expect((await bridge.execute({ name, input: {} }, { agent: worker })).isError).toBe(true);
      expect(await executeToolCall({ beforeToolExecute }, { id: name, name, input: {} }, ctx, state, active)).toContain('not active');
      expect(await executeToolCall({ beforeToolExecute }, { id: name, name: 'tool_call', input: { name, input: {} } }, ctx, state, active)).toContain('not active');
    }
    expect(beforeToolExecute).not.toHaveBeenCalled();
    expect(executeCapability).not.toHaveBeenCalled();
    expect((await bridge.execute({ name: 'skill', input: { skill: 'partner-research' } }, { agent: worker })).content)
      .toContain('Cite the primary evidence.');
    vi.stubEnv('KODAX_WEB_SEARCH_ENDPOINT', 'https://search.invalid/?q={query}');
    const fetch = vi.fn(async () => new Response('<a class="result__a" href="https://evidence.invalid/">Primary evidence</a>'));
    vi.stubGlobal('fetch', fetch);
    expect((await bridge.execute({ name: 'web_search', input: { query: 'evidence' } }, { agent: worker })).content)
      .toContain('Primary evidence');
    expect(fetch).toHaveBeenCalledOnce();
    for (const name of hostNames) {
      expect((await bridge.execute({ name, input: {} }, { agent: worker })).content).toContain(`completed:host:partner:${name}`);
      expect(await executeToolCall({ beforeToolExecute }, { id: name, name, input: {} }, ctx, state, active))
        .toContain(`completed:host:partner:${name}`);
    }
    expect(executeCapability).toHaveBeenCalledTimes(6);
    beforeToolExecute.mockResolvedValue('[Tool Error] Partner authorization denied');
    expect((await bridge.execute({ name: 'space_artifact_create', input: {} }, { agent: worker })).content).toContain('authorization denied');
    expect(await executeToolCall({ beforeToolExecute }, { id: 'denied', name: 'space_artifact_create', input: {} }, ctx, state, active))
      .toContain('authorization denied');
    expect(executeCapability).toHaveBeenCalledTimes(6);
    expect(ctx.skillDynamicContext).toBe(options.skillDynamicContext);
    expect(ctx.skillRegistry).toBe(skillRegistry);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects excluded tools before dispatch or permission callbacks even with a stale active inventory', async () => {
  const service = new LspService({ servers: [] });
  const definition = vi.spyOn(service, 'getDefinition').mockResolvedValue('must not execute');
  const beforeToolExecute = vi.fn(async () => undefined);
  const { ctx } = assembly({ workMode: 'agent', context: {
    workModePolicy: 'intersect', agentProfile: { id: 'partner' }, lspService: service,
    toolVisibilityPolicy: ({ name }) => name !== 'read',
  } });
  const active = ['tool_call', 'tool_describe', 'lsp_definition', 'read'];
  const state = buildRuntimeSessionState({ activeTools: active, modelSelection: {} });
  for (const name of ['lsp_definition', 'read']) {
    const input = { path: fileURLToPath(import.meta.url), line: 1, limit: 1 };
    for (const call of [{ id: name, name, input },
      { id: `bridge:${name}`, name: 'tool_call', input: { name, input } }]) {
      expect(await executeToolCall({ beforeToolExecute }, call, ctx, state, active)).toContain('not active');
    }
  }
  expect(beforeToolExecute).not.toHaveBeenCalled();
  expect(definition).not.toHaveBeenCalled();
});

it('keeps Partner child-agent controls denied even when an AMA actor host is available', async () => {
  const names = ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'agent_output'];
  const options: KodaXOptions = { provider: 'offline-fixture', agentMode: 'ama', workMode: 'agent', context: {
    workModePolicy: 'intersect', agentProfile: { id: 'partner' },
    toolVisibilityPolicy: ({ name }) => !names.includes(name),
  } };
  const { ctx, worker } = assembly(options);
  try {
    expect(ctx.actorControl).toBeDefined();
    await buildRunnerLlmAdapter(options, async (_messages, tools) => {
      for (const name of names) expect(tools.map(tool => tool.name)).not.toContain(name);
      return { textBlocks: [{ text: 'Partner answer' }], toolBlocks: [] };
    })([{ role: 'user', content: 'Research' }], worker);
    expect(await executeTool('tool_search', { query: `select:${names.join(',')}` }, ctx)).not.toContain('<function>');
    const bridge = worker.tools!.find(tool => tool.name === 'tool_call') as RunnableTool;
    for (const name of names) {
      expect((await bridge.execute({ name, input: {} }, { agent: worker })).isError).toBe(true);
    }
  } finally { await ctx.actorHost?.close(); }
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
