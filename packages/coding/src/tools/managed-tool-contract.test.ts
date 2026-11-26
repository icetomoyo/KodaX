import { describe, expect, it } from 'vitest';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXContextOptions, KodaXToolExecutionContext } from '../types.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../task-engine/_internal/managed-task/llm-adapter.js';
import { buildFallbackRoutingDecision } from '../reasoning.js';
import { getBuiltinToolDefinition, getToolDefinition } from './registry.js';
import { projectModelToolDefinition } from './model-tool-definition.js';
import { usesManagedToolView } from './managed-tool-contract.js';
import { withScriptModelTool } from '../agent-runtime/script/model.js';

const task = 'Inspect the repository and explain the implementation.';
const prompt = { prompt: task, decision: buildFallbackRoutingDecision(task) };
const makeWorker = (context: Partial<KodaXToolExecutionContext> = {}, full = true, partner?: string) =>
  buildRunnerAgentChain({ backups: new Map(), ...context }, undefined, undefined, undefined,
    full ? { ...prompt, partnerInstructions: partner } : undefined).worker;
const contract = (tool: KodaXToolDefinition) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema });
const unified = (name: string) => projectModelToolDefinition(getBuiltinToolDefinition(name)!, { kind: 'builtin' });
async function capture(agent: Agent, context?: KodaXContextOptions) {
  let tools: readonly KodaXToolDefinition[] = []; let requests = 0;
  const adapter = buildRunnerLlmAdapter({ provider: 'anthropic', context }, async (_messages, current) => {
    requests++; tools = current;
    return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
  });
  const instructions = typeof agent.instructions === 'function' ? agent.instructions(undefined) : agent.instructions;
  await adapter([{ role: 'system', content: instructions }, { role: 'user', content: task }], agent);
  expect(requests).toBe(1);
  return tools;
}

describe('unified tool text on every managed entry', () => {
  it('teaches the plan approval transition and the bounded initial Todo status', async () => {
    const exit = getBuiltinToolDefinition('exit_plan_mode')!.description;
    expect(exit).not.toContain('set_permission_mode');
    expect(exit).toMatch(/approv/i);
    for (const full of [false, true]) {
      const sent = await capture(makeWorker({}, full));
      expect(sent.find(tool => tool.name === 'todo_create')?.input_schema.properties?.status).toMatchObject({
        type: 'string', enum: ['pending', 'in_progress'],
      });
    }
  });

  it('carries the coordination teaching in the tool descriptions themselves', () => {
    expect(unified('spawn_agent').description).toContain('Implementation lanes require read_only:false and a disjoint owned module or file set');
    expect(unified('wait_agent').description).toContain('wait sparingly when required Agent evidence is on the critical path');
    expect(unified('todo_update').description).toContain('Keep one in_progress item per owner.');
    expect(unified('todo_update').description).toContain('Mark in_progress with activeForm before work, completed only after finishing');
    expect(unified('todo_create').description).toContain('Milestones are deliverables, not child Agents');
    const question = unified('ask_user_question').description;
    expect(question).toContain('Batch custom settings inherit flat settings');
    expect(question).toContain('never submitted automatically');
    expect(question).not.toContain('expiry fallback');
  });

  it('sends the registered contracts unchanged for root, SDK, child, custom-instruction and visibility-policy Workers', async () => {
    const workers = [makeWorker(), makeWorker({}, false), makeWorker({ currentAgentId: 'child' }),
      makeWorker({ toolVisibilityPolicy: () => true }), makeWorker({}, true, 'Partner instructions')];
    for (const worker of workers) {
      const before = JSON.stringify(worker.tools);
      const sent = await capture(worker);
      // tool_call alone may carry the activation bridge for tools moved off the native menu.
      for (const tool of sent.filter(item => item.name !== 'tool_call')) {
        expect(contract(tool)).toEqual(contract(worker.tools!.find(item => item.name === tool.name)!));
      }
      expect(sent.find(tool => tool.name === 'glob')!.description).toBe('Find file paths by glob.');
      expect(JSON.stringify(worker.tools)).toBe(before);
    }
  });

  it('bridges worktree tools for every root Worker and leaves a child its native menu', async () => {
    const bridged = (sent: readonly KodaXToolDefinition[]) => !sent.some(tool => tool.name === 'worktree_create')
      && (sent.find(tool => tool.name === 'tool_call')?.description ?? '').includes('worktree_create');
    for (const [worker, context] of [
      [makeWorker(), undefined], [makeWorker({}, false), undefined],
      [makeWorker({ toolVisibilityPolicy: () => true }), undefined], [makeWorker({ agentProfile: { id: 'reviewer' } }), undefined],
      [makeWorker(), { systemPromptOverride: 'Host instructions' }], [makeWorker(), { agentProfile: { id: 'reviewer' } }],
    ] as const) expect(bridged(await capture(worker, context))).toBe(true);
    expect(bridged(await capture(makeWorker({ currentAgentId: 'child' })))).toBe(false);
    expect(bridged(await capture(makeWorker(), { currentAgentId: 'child' }))).toBe(false);
  });

  it('keeps registry SDK projection identity for builtin tools', () => {
    const raw = getToolDefinition('glob')!;
    expect(projectModelToolDefinition(raw, { kind: 'builtin' })).toBe(raw);
  });

  it('derives the managed view from registry assembly and the child marker, not from copies', () => {
    const worker = makeWorker();
    expect(usesManagedToolView(worker)).toBe(true);
    expect(usesManagedToolView(makeWorker({}, false))).toBe(true);
    expect(usesManagedToolView(Object.freeze({ ...worker }))).toBe(false);
    const script = withScriptModelTool(worker, { backups: new Map() }, worker.tools!,
      async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
    expect(usesManagedToolView(script)).toBe(true);
    expect(usesManagedToolView(makeWorker({ currentAgentId: 'child' }))).toBe(false);
    expect(usesManagedToolView(worker, { currentAgentId: 'child' })).toBe(false);
  });
});
