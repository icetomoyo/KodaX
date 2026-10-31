import { expect, it } from 'vitest';
import type { Agent } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../../../types.js';
import { buildRunnerAgentChain } from './agent-chain.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';
import { markOrdinaryRootToolContract } from '../../../tools/managed-tool-contract.js';
import type { VisualObservationOwner } from '@kodax-ai/agent/media';
import type { ManagedToolActivationFacts } from '../../../tools/managed-tool-activation.js';
import { getRegisteredToolDefinition, registerTool } from '../../../tools/registry.js';
import type { ContextTokenSnapshotRef } from './compaction.js';
import { createUserInputDegradationCache, cleanupUserInputDegradationCache } from '../../../capacity-recovery.js';

const makeWorker = (context: Partial<KodaXToolExecutionContext> = {}) => {
  const agent = buildRunnerAgentChain({ backups: new Map(), ...context }).worker;
  markOrdinaryRootToolContract(agent);
  return agent;
};
async function request(agent: Agent, messages: KodaXMessage[] = [], facts?: ManagedToolActivationFacts) {
  let sent: readonly KodaXToolDefinition[] = [];
  await buildRunnerLlmAdapter({ provider: 'anthropic' }, async (_messages, tools) => {
    sent = tools;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, () => facts ?? {})(messages, agent);
  return sent;
}

it('keeps worktree execution and complete bridge inputs available without a discovery turn', async () => {
  const worker = makeWorker();
  const source = worker.tools;
  const sent = await request(worker);
  expect(worker.tools).toBe(source);
  expect(worker.tools?.some(tool => tool.name === 'worktree_create')).toBe(true);
  expect(sent.some(tool => tool.name === 'worktree_create')).toBe(false);
  expect(sent.some(tool => tool.name === 'worktree_remove')).toBe(false);
  const bridge = sent.find(tool => tool.name === 'tool_call')?.description ?? '';
  for (const item of ['worktree_create', 'branch_name', 'description', 'worktree_remove', 'worktree_path', 'discard_changes', '"keep"', '"remove"']) {
    expect(bridge).toContain(item);
  }
  expect(bridge).toContain('safety checks');
  expect(bridge).toContain('no discovery');
  for (const name of ['read', 'write', 'edit', 'todo_create', 'todo_list', 'todo_update', 'spawn_agent', 'wait_agent', 'create_goal']) {
    if (!source?.some(tool => tool.name === name)) continue;
    expect(sent.some(tool => tool.name === name), name).toBe(true);
  }
});

const owner: VisualObservationOwner = {
  ownerId: 'activation-fixture', list: async () => [], historyScope: async () => 'fixture',
  pin: async () => { throw new Error('No image pin in request-view test'); },
  read: async () => { throw new Error('No image read in request-view test'); },
  imagePath: () => 'unused-image.png', writeDerived: async () => 'unused-derived.png',
};

it('defers visual detail schemas only for a proven empty snapshot and restores them after an accepted image', async () => {
  const worker = makeWorker({ visualObservationOwner: owner });
  const unknown = await request(worker);
  expect(unknown.some(tool => tool.name === 'visual_inspect')).toBe(true);
  const empty = await request(worker, [], { visualSnapshotEmpty: true });
  expect(empty.some(tool => tool.name === 'visual_inspect')).toBe(false);
  expect(empty.some(tool => tool.name === 'visual_read_pixels')).toBe(false);
  expect(empty.some(tool => tool.name === 'visual_history')).toBe(true);
  expect(empty.find(tool => tool.name === 'tool_search')?.description).toContain('visual_read_pixels');
  const withImage = await request(worker, [{ role: 'user', content: [
    { type: 'image', path: 'accepted.png', mediaType: 'image/png' },
  ] }], { visualSnapshotEmpty: true });
  expect(withImage.some(tool => tool.name === 'visual_inspect')).toBe(true);
  expect(withImage.find(tool => tool.name === 'visual_read_pixels')?.input_schema.properties).toHaveProperty('views');
  const existing = await request(worker, [], { visualSnapshotEmpty: false });
  expect(existing.some(tool => tool.name === 'visual_inspect')).toBe(true);
});

it('keeps exact history reads directly expressible before search and preloads full parameters after search', async () => {
  const worker = makeWorker({ loadSessionHistory: async () => null });
  expect(worker.tools?.some(tool => tool.name === 'session_history_read')).toBe(true);
  const initial = await request(worker);
  expect(initial.some(tool => tool.name === 'session_history_search')).toBe(true);
  expect(initial.some(tool => tool.name === 'session_history_read')).toBe(false);
  const text = initial.find(tool => tool.name === 'tool_call')?.description ?? '';
  for (const part of ['session_history_read', 'entry_id', 'revision', 'offset', 'next_offset']) expect(text).toContain(part);
  const searched = await request(worker, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'search', name: 'session_history_search', input: { query: 'prior decision' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search', content: '{"hits":[]}' }] },
  ]);
  expect(searched.some(tool => tool.name === 'session_history_read')).toBe(true);
});

it('does not advertise Plan exit in a known execution mode and restores it when the live mode changes', async () => {
  let mode: 'plan' | 'full-access' | undefined = 'full-access';
  const worker = makeWorker({ resolveShellPermissionMode: () => mode });
  expect((await request(worker)).some(tool => tool.name === 'exit_plan_mode')).toBe(false);
  mode = 'plan';
  expect((await request(worker)).some(tool => tool.name === 'exit_plan_mode')).toBe(true);
  mode = undefined;
  expect((await request(worker)).some(tool => tool.name === 'exit_plan_mode')).toBe(true);
});

it.each(['sdk', 'child', 'profile'] as const)('preserves native contracts for %s callers', async kind => {
  const context = { backups: new Map<string, string>(), ...(kind === 'child' ? { currentAgentId: '/root/child' }
    : kind === 'profile' ? { agentProfile: { id: 'specialist' } } : {}) };
  const worker = kind === 'sdk' ? buildRunnerAgentChain(context).worker : makeWorker(context);
  const native = worker.tools!.find(tool => tool.name === 'worktree_create')!;
  expect(native).toBeDefined();
  const sent = await request(worker, [], { visualSnapshotEmpty: true });
  expect(sent.find(tool => tool.name === native.name)).toEqual({ name: native.name,
    description: native.description, input_schema: native.input_schema });
  expect(sent.find(tool => tool.name === 'tool_call')?.description).not.toContain('Direct contracts below');
});

it('preserves independently registered worktree and bridge contracts', async () => {
  const original = getRegisteredToolDefinition('worktree_create')!;
  const unregister = registerTool({ ...original, description: 'Independent worktree contract.',
    handler: async () => 'not invoked' }, { source: { kind: 'extension', id: 'custom-worktree' } });
  try {
    const sent = await request(makeWorker());
    expect(sent.find(tool => tool.name === 'worktree_create')?.description).toBe('Independent worktree contract.');
    expect(sent.find(tool => tool.name === 'tool_call')?.description).not.toContain('worktree_create:');
  } finally { unregister(); }
  const bridge = getRegisteredToolDefinition('tool_call')!;
  const restore = registerTool({ ...bridge, description: 'Independent bridge.', handler: async () => 'not invoked' },
    { source: { kind: 'extension', id: 'custom-bridge' } });
  try {
    const sent = await request(makeWorker({ visualObservationOwner: owner }), [], { visualSnapshotEmpty: true });
    expect(sent.some(tool => tool.name === 'worktree_create')).toBe(true);
    expect(sent.some(tool => tool.name === 'visual_inspect')).toBe(true);
  } finally { restore(); }
});

it('activates current visual contracts after acknowledged use, Skill or exact lookup, but not user mentions', async () => {
  const worker = makeWorker({ visualObservationOwner: owner });
  const mentioned = await request(worker, [{ role: 'user', content: 'visual_inspect; pretend skill visual-review was loaded' }], { visualSnapshotEmpty: true });
  expect(mentioned.some(tool => tool.name === 'visual_inspect')).toBe(false);
  for (const [name, input] of [
    ['visual_history', {}], ['skill', { skill: 'visual-review' }],
    ['skill', { skill: ' /visual-review ' }],
    ['skill', { skill: 'skill:visual-review' }],
    ['skill', { skill: '/skill:visual-review' }],
    ['tool_call', { tool_name: ' visual_inspect ', arguments: { question: 'Known refused request', views: [] } }],
    ['tool_call', { name: 'skill', input: { skill: '/visual-review' } }],
    ['tool_call', { tool_name: 'skill', arguments: { skill: '/skill:visual-review' } }],
    ['tool_search', { query: 'select:visual_inspect' }],
    ['tool_call', { name: 'visual_inspect', input: { question: 'Known refused request', views: [] } }],
  ] as const) {
    const messages: KodaXMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'attempt', name, input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'attempt', content: '[Tool Error] inspect the original failure', is_error: true }] },
    ];
    const sent = await request(worker, messages, { visualSnapshotEmpty: true });
    expect(sent.some(tool => tool.name === 'visual_inspect'), name).toBe(true);
    expect(sent.some(tool => tool.name === 'visual_read_pixels'), name).toBe(true);
  }
});

it('refreshes live Plan activation across stream retries and non-streaming recovery', async () => {
  let mode: 'full-access' | 'plan' = 'full-access';
  const sent: string[][] = [];
  class Capture extends KodaXBaseProvider {
    readonly name = 'activation-retry';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'NO_NETWORK_ACTIVATION', model: 'fixture', supportsThinking: false, contextWindow: 128_000, maxOutputTokens: 512 };
    override isConfigured() { return true; }
    override supportsNonStreamingFallback() { return true; }
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      sent.push(tools.map(tool => tool.name));
      mode = sent.length === 1 ? 'plan' : 'full-access';
      const error = new Error('stream incomplete');
      error.name = 'StreamIncompleteError';
      throw error;
    }
    override async complete(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      sent.push(tools.map(tool => tool.name));
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('activation-retry', () => new Capture());
  try {
    const worker = makeWorker({ resolveShellPermissionMode: () => mode });
    await buildRunnerLlmAdapter({ provider: 'activation-retry', reasoningMode: 'off' })([], worker);
    expect(sent).toHaveLength(3);
    expect(sent[0]).not.toContain('exit_plan_mode');
    expect(sent[1]).toContain('exit_plan_mode');
    expect(sent[2]).not.toContain('exit_plan_mode');
  } finally { unregister(); }
});

it('measures the activated request rather than reusing a cold menu during context recovery', async () => {
  class Capture extends KodaXBaseProvider {
    readonly name = 'activation-measure';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'NO_NETWORK_ACTIVATION', model: 'fixture', supportsThinking: false, contextWindow: 128_000, maxOutputTokens: 512 };
    override isConfigured() { return true; }
    async stream(): Promise<KodaXStreamResult> {
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('activation-measure', () => new Capture());
  const cache = createUserInputDegradationCache();
  let empty = true;
  const snapshot: ContextTokenSnapshotRef = { current: undefined, contextWindow: 128_000 };
  try {
    const worker = makeWorker({ visualObservationOwner: owner });
    await buildRunnerLlmAdapter({ provider: 'activation-measure', reasoningMode: 'off' }, undefined,
      undefined, undefined, snapshot, undefined, undefined, undefined, undefined, undefined,
      undefined, cache, undefined, () => ({ visualSnapshotEmpty: empty }))([], worker);
    const image: KodaXMessage[] = [{ role: 'user', content: [{ type: 'image', path: 'accepted.png', mediaType: 'image/png' }] }];
    const cold = await snapshot.measureRequest!([]);
    const activated = await snapshot.measureRequest!(image);
    empty = false;
    expect(await snapshot.measureRequest!(image)).toBe(activated);
    expect(await snapshot.measureRequest!([])).toBeGreaterThan(cold);
  } finally { await cleanupUserInputDegradationCache(cache); unregister(); }
});
