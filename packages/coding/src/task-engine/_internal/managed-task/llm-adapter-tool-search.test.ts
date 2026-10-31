import { expect, it } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { buildRunnerAgentChain } from './agent-chain.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';
import { inheritOrdinaryRootToolContract, markOrdinaryRootToolContract } from '../../../tools/managed-tool-contract.js';
import { toolSearchHandler } from '../../../tools/tool-search.js';
import { getToolDefinition, registerTool } from '../../../tools/index.js';
import { TOOL_SEARCH_DEFINITION } from '../../../tools/tool-search.js';
import { withScriptModelTool } from '../../../agent-runtime/script/model.js';
import type { KodaXContextOptions, KodaXToolExecutionContext } from '../../../types.js';
import { listToolDefinitions } from '../../../tools/index.js';
import { countTokens } from '../../../tokenizer.js';
import type { ContextTokenSnapshotRef } from './compaction.js';
import { createUserInputDegradationCache, cleanupUserInputDegradationCache } from '../../../capacity-recovery.js';

async function history(): Promise<KodaXMessage[]> {
  const content = await toolSearchHandler({ query: 'select:web_fetch' }, { backups: new Map() });
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'lookup', name: 'tool_search', input: { query: 'select:web_fetch' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup', content }] },
  ];
}

it('projects only the provider request and retains full canonical tool-search evidence', async () => {
  const context = { backups: new Map<string, string>() };
  const agent = buildRunnerAgentChain(context).worker;
  markOrdinaryRootToolContract(agent);
  const result = await toolSearchHandler({ query: 'select:web_fetch' }, context);
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'lookup', name: 'tool_search', input: { query: 'select:web_fetch' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup', content: result }] },
  ];
  let sent: readonly KodaXMessage[] = [];
  await buildRunnerLlmAdapter({}, async (wire, tools) => {
    sent = wire;
    expect(tools.find(tool => tool.name === 'web_fetch')?.input_schema.properties.url).toBeDefined();
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  })(messages, agent);
  expect(JSON.stringify(sent)).not.toContain('parameters\\":');
  expect(JSON.stringify(sent)).toContain('current tool contracts');
  expect(JSON.stringify(messages)).toContain('parameters\\":');
});

it.each<Partial<KodaXContextOptions>>([
  { currentAgentId: '/root/specialist' }, { agentProfile: { id: 'sdk' } },
  { systemPromptOverride: 'Host-specific instructions.' }, { toolVisibilityPolicy: () => true },
])('preserves explicit SDK, specialist and visibility contracts: %j', async context => {
  const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
  markOrdinaryRootToolContract(agent);
  let sent: readonly KodaXMessage[] = [];
  const messages = await history();
  await buildRunnerLlmAdapter({ context }, async wire => {
    sent = wire;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  })(messages, agent);
  expect(sent).toEqual(messages);
});

it('preserves a same-name independently registered search tool', async () => {
  const messages = await history();
  const unregister = registerTool({ ...TOOL_SEARCH_DEFINITION, description: 'Independent help contract.' },
    { source: { kind: 'extension', id: 'independent-help' } });
  try {
    const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
    markOrdinaryRootToolContract(agent);
    let sent: readonly KodaXMessage[] = [];
    await buildRunnerLlmAdapter({}, async wire => { sent = wire; return { textBlocks: [{ text: 'done' }], toolBlocks: [] }; })(messages, agent);
    expect(sent).toEqual(messages);
  } finally { unregister(); }
});

it('uses a proven Script leaf contract and leaves canonical history intact', async () => {
  const context: KodaXToolExecutionContext = { backups: new Map() };
  const root = buildRunnerAgentChain(context).worker;
  markOrdinaryRootToolContract(root);
  const leaf = getToolDefinition('web_fetch');
  if (!leaf) throw new Error('Missing web fetch');
  const script = withScriptModelTool(root, context, [leaf], async () => { throw new Error('No Script execution during capture'); });
  inheritOrdinaryRootToolContract(root, script);
  const messages = await history();
  const requests: KodaXMessage[][] = [];
  const adapter = buildRunnerLlmAdapter({}, async (wire, tools) => {
    requests.push([...wire]);
    expect(tools.some(tool => tool.name === 'web_fetch')).toBe(false);
    expect(tools.find(tool => tool.name === 'script_exec')?.description).toContain('"url"');
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  await adapter(messages, script);
  await adapter([...messages, { role: 'user', content: 'Continue.' }], script);
  expect(JSON.stringify(requests[0])).toContain('current tool contracts');
  expect(requests[1]?.slice(0, requests[0]?.length)).toEqual(requests[0]);
  expect(JSON.stringify(messages)).toContain('parameters\\":');
});

it('retains the same projected parameters across real stream retries and non-streaming fallback', async () => {
  const messages = await history(), sent: string[] = [];
  class Fallback extends KodaXBaseProvider {
    readonly name = 'search-help-fallback';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'NO_NETWORK_SEARCH_HELP', model: 'fixture', contextWindow: 128_000, maxOutputTokens: 512 };
    override isConfigured() { return true; }
    override supportsNonStreamingFallback() { return true; }
    async stream(wire: KodaXMessage[]): Promise<KodaXStreamResult> {
      sent.push(JSON.stringify(wire));
      const error = new Error('stream incomplete'); error.name = 'StreamIncompleteError'; throw error;
    }
    override async complete(wire: KodaXMessage[]): Promise<KodaXStreamResult> {
      sent.push(JSON.stringify(wire));
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('search-help-fallback', () => new Fallback());
  try {
    const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
    markOrdinaryRootToolContract(agent);
    await buildRunnerLlmAdapter({ provider: 'search-help-fallback', reasoningMode: 'off' })(messages, agent);
    expect(sent).toHaveLength(3);
    for (const wire of sent) {
      expect(wire).toContain('current tool contracts');
      expect(wire).not.toContain('parameters\\":');
    }
    expect(JSON.stringify(messages)).toContain('parameters\\":');
  } finally { unregister(); }
});

it('restores the full search schema when actual context fitting removes its native contract', async () => {
  const unregisterTarget = registerTool({ name: 'host_detail', description: 'Inspect one detailed external capability. '.repeat(1000),
    input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Exact external item key selected from current evidence.' } }, required: ['key'] },
    sideEffect: 'readonly', handler: async () => 'not executed' }, { source: { kind: 'extension', id: 'host' } });
  const unregisterOther = registerTool({ name: 'host_other', description: 'Inspect one detailed external capability. '.repeat(900),
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', handler: async () => 'not executed' },
  { source: { kind: 'extension', id: 'host' } });
  const sent: { text: string; tools: string[]; system: string }[] = [];
  class Capture extends KodaXBaseProvider {
    readonly name = 'search-help-fit';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'NO_NETWORK_SEARCH_HELP', model: 'fixture', contextWindow: 128_000, maxOutputTokens: 512 };
    override isConfigured() { return true; }
    async stream(wire: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      sent.push({ text: JSON.stringify(wire), tools: tools.map(tool => tool.name), system });
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregisterProvider = registerModelProvider('search-help-fit', () => new Capture());
  const cache = createUserInputDegradationCache();
  try {
    const active = new Set(['read', 'tool_search', 'tool_call', 'host_detail', 'host_other']);
    const context = { backups: new Map<string, string>(), excludeTools: listToolDefinitions().map(tool => tool.name).filter(name => !active.has(name)) };
    const agent = buildRunnerAgentChain(context).worker;
    markOrdinaryRootToolContract(agent);
    const content = await toolSearchHandler({ query: 'select:host_detail' }, context);
    const messages: KodaXMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'host-help', name: 'tool_search', input: { query: 'select:host_detail' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'host-help', content }] },
    ];
    const options = { provider: 'search-help-fit', reasoningMode: 'off' as const };
    await buildRunnerLlmAdapter(options)(messages, agent);
    expect(sent[0]!.tools).toContain('host_detail');
    expect(sent[0]!.text).toContain('current tool contracts');
    const capacity: ContextTokenSnapshotRef = { current: undefined,
      contextWindow: countTokens(sent[0]!.system) + countTokens(String(content)) + 4096 };
    await buildRunnerLlmAdapter(options, undefined, undefined, undefined, capacity,
      undefined, undefined, undefined, undefined, undefined, undefined, cache)(messages, agent);
    expect(sent[1]!.tools).not.toContain('host_detail');
    expect(sent[1]!.tools).toContain('tool_call');
    expect(sent[1]!.text).toContain('parameters\\":');
    expect(sent[1]!.text).not.toContain('current tool contracts');
    expect(capacity.measureRequest).toBeTypeOf('function');
    expect(await capacity.measureRequest!(messages)).toBeGreaterThan(countTokens(String(content)));
    expect(JSON.stringify(messages)).toContain('parameters\\":');
  } finally { await cleanupUserInputDegradationCache(cache); unregisterProvider(); unregisterOther(); unregisterTarget(); }
});
