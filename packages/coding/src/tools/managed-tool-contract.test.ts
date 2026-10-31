import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXContextOptions, KodaXToolExecutionContext } from '../types.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../task-engine/_internal/managed-task/llm-adapter.js';
import { buildFallbackRoutingDecision } from '../reasoning.js';
import { getToolDefinition, getBuiltinToolDefinition, getRegisteredToolDefinition, registerTool } from './registry.js';
import { markRegistryManagedAgent, projectModelToolDefinition } from './model-tool-definition.js';
import { inheritOrdinaryRootToolContract, markOrdinaryRootToolContract, projectManagedToolContracts } from './managed-tool-contract.js';
import { managedToolText } from './managed-tool-text.js';
import { withScriptModelTool } from '../agent-runtime/script/model.js';

const task = 'Inspect the repository and explain the implementation.';
const prompt = { prompt: task, decision: buildFallbackRoutingDecision(task) };
const makeWorker = (context: Partial<KodaXToolExecutionContext> = {}, full = true, partner?: string) => {
  const worker = buildRunnerAgentChain({ backups: new Map(), ...context }, undefined, undefined, undefined,
    full ? { ...prompt, partnerInstructions: partner } : undefined).worker;
  if (full && !partner) markOrdinaryRootToolContract(worker);
  return worker;
};
const contract = (tool: KodaXToolDefinition) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema });
function structural(value: unknown, properties = false): unknown {
  if (Array.isArray(value)) return value.map(item => structural(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => properties || key !== 'description')
    .map(([key, item]) => [key, structural(item, key === 'properties')]));
  return value;
}
async function capture(agent: Agent, context?: KodaXContextOptions) {
  let tools: readonly KodaXToolDefinition[] = []; let system = ''; let requests = 0;
  const adapter = buildRunnerLlmAdapter({ provider: 'anthropic', context }, async (_messages, current, text) => {
    requests++; tools = current; system = text;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  const instructions = typeof agent.instructions === 'function' ? agent.instructions(undefined) : agent.instructions;
  await adapter([{ role: 'system', content: instructions }, { role: 'user', content: task }], agent);
  expect(requests).toBe(1);
  expect(system).toBe(instructions);
  return tools;
}

describe('ordinary managed root tool presentation', () => {
  it('exposes the bounded initial Todo status in both canonical and compact contracts', async () => {
    for (const full of [false, true]) {
      const sent = await capture(makeWorker({}, full));
      expect(sent.find(tool => tool.name === 'todo_create')?.input_schema.properties?.status).toMatchObject({
        type: 'string', enum: ['pending', 'in_progress'],
      });
    }
  });

  it('shortens duplicate tool teaching without changing Worker instructions, parameters or strategy', async () => {
    const worker = makeWorker(); const before = JSON.stringify(worker.tools);
    const sent = await capture(worker);
    expect(sent.find(tool => tool.name === 'glob')!.description).toBe('Find file paths by glob.');
    for (const tool of sent) {
      const original = worker.tools!.find(item => item.name === tool.name)!;
      expect(structural(tool.input_schema), tool.name).toEqual(structural(original.input_schema));
    }
    for (const name of ['spawn_agent', 'todo_create', 'todo_update', 'todo_list', 'wait_agent']) {
      const description = managedToolText[name]?.description;
      expect(description, name).toBeDefined();
      const original = worker.tools!.find(tool => tool.name === name);
      if (original) {
        expect(sent.find(tool => tool.name === name)?.description).toBe(description);
        expect(description!.length, name).toBeLessThan(original.description.length);
      }
    }
    const question = sent.find(tool => tool.name === 'ask_user_question')!;
    expect(structural(question.input_schema)).toEqual(structural(getBuiltinToolDefinition('ask_user_question')!.input_schema));
    expect(question.description).toContain('Batch custom settings inherit flat settings');
    expect(question.description).toContain('never submitted automatically');
    expect(question.description).toContain('unanswered');
    expect(question.description).not.toContain('expiry fallback');
    expect(JSON.stringify(contract(question)).length).toBeLessThan(JSON.stringify(contract(getBuiltinToolDefinition('ask_user_question')!)).length);
    expect(JSON.stringify(worker.tools)).toBe(before);
    expect(getToolDefinition('glob')!.description).not.toBe('Find file paths by glob.');
    expect(sent.find(tool => tool.name === 'todo_update')!.description).toContain('Mark in_progress with activeForm before work, completed only after finishing');
  });

  it('keeps fallback SDK, children, custom instructions and consumer visibility contracts intact', async () => {
    for (const worker of [makeWorker({}, false), makeWorker({ currentAgentId: 'child' }),
      makeWorker({ toolVisibilityPolicy: () => true }),
      makeWorker({}, true, 'Partner instructions')]) {
      const sent = await capture(worker);
      for (const tool of sent) expect(contract(tool)).toEqual(contract(worker.tools!.find(item => item.name === tool.name)!));
    }
    const worker = makeWorker();
    const copied: Agent = Object.freeze({ ...worker }); // Identical text is not factory provenance.
    expect((await capture(copied)).map(contract)).toEqual(worker.tools!.map(contract));
    for (const context of [{ currentAgentId: 'child' }, { systemPromptOverride: 'Host instructions' }]) {
      const sent = await capture(worker, context);
      expect(sent.find(tool => tool.name === 'glob')!.description).toBe(getToolDefinition('glob')!.description);
    }
  });

  it('leaves registry SDK projection unchanged', () => {
    const raw = getToolDefinition('glob')!;
    expect(projectModelToolDefinition(raw, { kind: 'builtin' })).toBe(raw);
  });

  it('rewrites every audited annotation without dropping parameters or mutating the canonical inventory', () => {
    const tools = Object.keys(managedToolText).map(name => projectModelToolDefinition(getBuiltinToolDefinition(name)!, { kind: 'builtin' }));
    const before = JSON.stringify(tools);
    // Changing canonical teaching requires re-auditing the shorter wording, not silently carrying it forward.
    // History now distinguishes entry evidence versions from strict global snapshots.
    expect(createHash('sha256').update(JSON.stringify(tools.filter(tool => tool.name !== 'ask_user_question').map(contract))).digest('hex')).toMatchInlineSnapshot(`"7822ed1b8b285eacb174f93ab844276796129ad51c76462f1dff770709a866cf"`);
    const agent = markRegistryManagedAgent({ name: 'worker', instructions: '', tools }, { backups: new Map() });
    markOrdinaryRootToolContract(agent);
    const projected = projectManagedToolContracts(agent, tools);
    expect(projected).toHaveLength(33);
    projected.forEach((tool, index) => {
      expect(tool, tool.name).not.toEqual(tools[index]);
      expect(structural(tool.input_schema), tool.name).toEqual(structural(tools[index]!.input_schema));
      const text = managedToolText[tool.name]!;
      expect(tool.description).toBe(text.description ?? tools[index]!.description);
      for (const [path, description] of Object.entries(text.annotations ?? {})) {
        const node = path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], tool.input_schema);
        expect((node as Record<string, unknown>).description, `${tool.name}.${path}`).toBe(description ?? undefined);
      }
    });
    expect(JSON.stringify(tools)).toBe(before);
    // The business parameter called description is retained, unlike schema annotations.
    expect(projected.find(tool => tool.name === 'todo_create')!.input_schema.properties).toHaveProperty('description');
    expect(JSON.stringify(projected.find(tool => tool.name === 'todo_create')!.input_schema)).toContain('Supply for each milestone');
  });

  it('requires re-audit when the canonical question contract evolves', () => {
    expect(createHash('sha256').update(JSON.stringify(contract(getBuiltinToolDefinition('ask_user_question')!))).digest('hex'))
      .toBe('0b712ab5ff41445ed079e6b50fcc5a38acf77b45f9aaceef1b6cd38442f74672');
  });

  it('does not inherit eligibility through SDK construction or Script wrappers', () => {
    const sdk = buildRunnerAgentChain({ backups: new Map() }, undefined, undefined, undefined, prompt).worker;
    expect(projectManagedToolContracts(sdk, sdk.tools!)).toBe(sdk.tools);
    const worker = makeWorker();
    const script = withScriptModelTool(worker, { backups: new Map() }, worker.tools!,
      async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
    expect(projectManagedToolContracts(script, script.tools!)).toBe(script.tools);
  });

  it('shares native Script control wording only after explicit eligible-root transfer', () => {
    const worker = makeWorker();
    const wrap = () => withScriptModelTool({ ...worker, tools: [...worker.tools!, getBuiltinToolDefinition('agent_output')!] }, { backups: new Map() }, [],
      async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
    const script = wrap();
    inheritOrdinaryRootToolContract(worker, script);
    const sent = projectManagedToolContracts(script, script.tools!);
    expect(sent.find(tool => tool.name === 'agent_output')!.description).toBe(managedToolText.agent_output!.description);
    for (const name of ['spawn_agent', 'todo_create', 'todo_update', 'todo_list', 'wait_agent']) {
      const original = script.tools!.find(tool => tool.name === name);
      if (original) expect(sent.find(tool => tool.name === name)?.description, name).toBe(managedToolText[name]!.description);
    }
    expect(sent.find(tool => tool.name === 'script_exec')).toBe(script.tools!.find(tool => tool.name === 'script_exec'));
    for (const source of [makeWorker({}, false), makeWorker({ currentAgentId: 'child' }),
      makeWorker({ toolVisibilityPolicy: () => true }), makeWorker({ agentProfile: { id: 'reviewer' } })]) {
      const unqualified = wrap();
      inheritOrdinaryRootToolContract(source, unqualified);
      expect(projectManagedToolContracts(unqualified, unqualified.tools!)).toBe(unqualified.tools);
    }
    const custom = wrap();
    inheritOrdinaryRootToolContract(worker, custom, { systemPromptOverride: 'Host instructions' });
    expect(projectManagedToolContracts(custom, custom.tools!)).toBe(custom.tools);
  });

  it('preserves host-modified same-name contracts and extension registrations', async () => {
    const worker = makeWorker();
    const original = worker.tools!.find(tool => tool.name === 'glob')!;
    const branded = { ...original, description: 'Host glob: restricted scope and separate semantics.' };
    expect(projectManagedToolContracts(worker, [branded])[0]).toBe(branded);
    const changedSchema = { ...original, input_schema: { ...original.input_schema, required: ['path', 'pattern'] } };
    expect(projectManagedToolContracts(worker, [changedSchema])[0]).toBe(changedSchema);
    const unregister = registerTool({ ...getRegisteredToolDefinition('glob')!, handler: async () => 'host' }, { source: { kind: 'extension' } });
    try { expect(projectManagedToolContracts(worker, [original])[0]).toBe(original); }
    finally { unregister(); }
  });
});
