import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { getToolDefinition, getRegisteredToolDefinition, registerTool } from '../../../tools/registry.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';
import { buildRunnerAgentChain } from './agent-chain.js';
import fs from 'node:fs/promises';
import path from 'node:path';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

it('keeps native literal and provider search executable through discovery on the default Worker', async () => {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'kodax-search-menu-'));
  try {
    await fs.writeFile(path.join(workspace, 'literal.ts'), 'const value = "a.b[x]";\n');
    const agent = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace,
      extensionRuntime: { searchCapabilities: async () => [{ title: 'Virtual result', path: '/virtual/provider.ts' }] } as never,
    }).worker;
    let sent: readonly KodaXToolDefinition[] = [];
    const adapter = buildRunnerLlmAdapter({}, async (_messages, tools) => {
      sent = tools;
      return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
    });
    await adapter([{ role: 'user', content: 'Find the implementation.' }], agent);
    expect(sent.map(tool => tool.name)).toContain('code_search');
    expect(sent.map(tool => tool.name)).toEqual(expect.arrayContaining(['grep', 'glob', 'read', 'repo_overview']));
    const discover = agent.tools?.find(tool => tool.name === 'tool_search');
    const bridge = agent.tools?.find(tool => tool.name === 'tool_call');
    if (!discover || !bridge) throw new Error('Missing builtin bridge');
    const contract = await discover.execute({ query: 'select:code_search' }, { agent });
    expect(String(contract.content)).toContain('provider_id');
    const literal = await bridge.execute({ name: 'code_search', input: { query: 'a.b[x]' } }, { agent });
    expect(String(literal.content)).toContain('literal.ts:1');
    const virtual = await bridge.execute({ name: 'code_search', input: { query: 'virtual', provider_id: 'fixture' } }, { agent });
    expect(String(virtual.content)).toContain('/virtual/provider.ts');
    expect(agent.tools?.map(tool => tool.name)).toContain('code_search');
  } finally {
    if (path.dirname(workspace) !== path.resolve(tmpdir()) || !path.basename(workspace).startsWith('kodax-search-menu-')) throw new Error('Unsafe fixture path');
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('preserves explicit profiles, child menus, missing replacements and extension search contracts', async () => {
  let sent: readonly KodaXToolDefinition[] = [];
  const capture = async (_messages: readonly KodaXMessage[], tools: readonly KodaXToolDefinition[]) => {
    sent = tools;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  };
  const context = { backups: new Map<string, string>() };
  const worker = buildRunnerAgentChain(context).worker;
  for (const options of [
    { context: { currentAgentId: '/root/explorer' } },
    { context: { agentProfile: { id: 'explicit-sdk-profile' } } },
    { context: { toolVisibilityPolicy: () => true } },
  ]) {
    await buildRunnerLlmAdapter(options, capture)([{ role: 'user', content: 'Inspect.' }], worker);
    expect(sent.map(tool => tool.name)).toContain('code_search');
  }
  for (const agent of [
    { ...worker, name: 'repo-explorer' },
    { ...worker, tools: worker.tools?.filter(tool => tool.name !== 'tool_call') },
    { ...worker, tools: worker.tools?.filter(tool => tool.name !== 'grep') },
  ]) {
    await buildRunnerLlmAdapter({}, capture)([{ role: 'user', content: 'Inspect.' }], agent);
    expect(sent.map(tool => tool.name)).toContain('code_search');
  }
  const builtin = getRegisteredToolDefinition('code_search');
  if (!builtin) throw new Error('Missing search');
  const unregister = registerTool({ ...builtin, description: 'Independent extension search.' },
    { source: { kind: 'extension', id: 'independent-search' } });
  try {
    await buildRunnerLlmAdapter({}, capture)([{ role: 'user', content: 'Inspect.' }], buildRunnerAgentChain(context).worker);
    expect(sent.find(tool => tool.name === 'code_search')?.description).toBe('Independent extension search.');
  } finally { unregister(); }
});

it('retains native schemas on the managed path before and after compaction', async () => {
  const agent = buildRunnerAgentChain({ backups: new Map(), executionCwd: tmpdir() }).worker;
  let sent: readonly KodaXToolDefinition[] = [];
  let system = '';
  const adapter = buildRunnerLlmAdapter({ provider: 'unconfigured-capture' }, async (_messages, tools, instructions) => {
    sent = tools;
    system = instructions;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  await adapter([{ role: 'user', content: 'Read a web page after discovering its tool.' }], agent);
  expect(sent.map(tool => tool.name)).toContain('web_fetch');
  expect(sent.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'edit', 'todo_update', 'tool_search', 'tool_call']));
  expect(system).not.toContain('Additional Tools');
  expect(agent.tools?.map(tool => tool.name)).toContain('web_fetch');
  const firstSystem = system;
  await adapter([{ role: 'user', content: 'Resume after compaction; the prior search result was summarized away.' }], agent);
  expect(system).toBe(firstSystem);
  expect(sent.map(tool => tool.name)).toContain('web_fetch');
});

it('retains direct schemas without a builtin discovery bridge and for an independent extension override', async () => {
  const builtin = getRegisteredToolDefinition('web_fetch');
  if (!builtin) throw new Error('Missing web_fetch');
  let sent: readonly KodaXToolDefinition[] = [];
  const adapter = buildRunnerLlmAdapter({}, async (_messages, tools) => {
    sent = tools;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  await adapter([{ role: 'user', content: 'Fetch a page.' }], { name: 'custom', instructions: '', tools: [builtin] });
  expect(sent.map(tool => tool.name)).toContain('web_fetch');
  const unregister = registerTool({ ...builtin, description: 'Independent extension fetch contract.' },
    { source: { kind: 'extension', id: 'independent-fetch' } });
  try {
    const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
    await adapter([{ role: 'user', content: 'Fetch a page.' }], agent);
    expect(sent.find(tool => tool.name === 'web_fetch')?.description).toBe('Independent extension fetch contract.');
  } finally { unregister(); }
});

it('retains custom Agent schemas even when their names match builtin discovery tools', async () => {
  const names = ['web_fetch', 'tool_search', 'tool_call'];
  const tools = names.map(name => {
    const builtin = getToolDefinition(name);
    if (!builtin) throw new Error(`Missing ${name}`);
    return { ...builtin, description: `Custom ${name} contract`, execute: async () => ({ content: 'custom' }) };
  });
  let sent: readonly KodaXToolDefinition[] = [];
  let system = '';
  const adapter = buildRunnerLlmAdapter({}, async (_messages, definitions, instructions) => {
    sent = definitions;
    system = instructions;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  await adapter([{ role: 'user', content: 'Fetch a page.' }], { name: 'custom', instructions: '', tools });
  expect(sent.map(tool => tool.name)).toEqual(names);
  expect(system).not.toContain('Additional Tools');
});

it.each([false, true])('projects legacy todo at the final managed boundary while preserving caller constraints (custom=%s)', async (custom) => {
  const registered = getToolDefinition('todo_update');
  if (!registered) throw new Error('Missing todo_update');
  const original = custom ? {
    ...registered,
    input_schema: {
      ...registered.input_schema,
      properties: { ...registered.input_schema.properties, label: { type: 'string' }, forbidden: false },
      required: ['op', 'items', 'status'],
    },
  } : registered;
  const before = structuredClone(original.input_schema);
  let sent: KodaXToolDefinition[] = [];
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = 'todo-contract';
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: 'KODAX_TODO_CONTRACT_TEST_KEY', model: 'scripted', supportsThinking: false,
      reasoningCapability: 'prompt-only' as const, maxOutputTokens: 32000,
    };
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      sent = tools;
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_TODO_CONTRACT_TEST_KEY', 'local-test-key');
  registerModelProvider('todo-contract', () => new CaptureProvider());
  const adapter = buildRunnerLlmAdapter({ provider: 'todo-contract',
    context: { gitRoot: tmpdir(), executionCwd: tmpdir(), repoIntelligenceMode: 'off' } });
  await adapter([{ role: 'user', content: 'Continue the current plan.' }], {
    name: 'kodax/role/worker', instructions: '',
    tools: [{ ...original, execute: async () => ({ content: 'unused' }) }],
  });
  const todo = sent.find((tool) => tool.name === 'todo_update');
  expect(todo?.input_schema.required).toEqual(custom ? ['status', 'id'] : ['id']);
  expect(todo?.input_schema.properties).not.toHaveProperty('op');
  expect(todo?.input_schema.properties).not.toHaveProperty('items');
  expect(original.input_schema).toEqual(before);
  if (custom) {
    expect(todo?.input_schema.properties.label).toEqual({ type: 'string' });
    expect(todo?.input_schema.properties.forbidden).toBe(false);
  }
});
