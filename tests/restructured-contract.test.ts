import { expect, it, vi } from 'vitest';
import type { FrozenInput } from './first-turn-eval-support.js';
import { restructuredContractInput } from './restructured-contract.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { inheritOrdinaryRootToolContract, markOrdinaryRootToolContract } from '../packages/coding/src/tools/managed-tool-contract.js';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { getScriptModelContracts, withScriptModelTool } from '../packages/coding/src/agent-runtime/script/model.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { createAgentActorController } from '../packages/agent/src/actors/index.js';
import { buildMemoryRulesSection } from '../packages/coding/src/prompts/memory-rules.js';
import { SELF_KNOWLEDGE_ROUTING_RULE } from '../packages/coding/src/self-knowledge/routing-rule.js';
import { getBuiltinToolDefinition } from '../packages/coding/src/tools/registry.js';
import type { Agent } from '@kodax-ai/agent';

const instructions = (agent: Agent) => typeof agent.instructions === 'function' ? agent.instructions(undefined) : agent.instructions;

async function fixture(script = false): Promise<FrozenInput & { scriptContracts?: ReturnType<typeof getScriptModelContracts> }> {
  const task = 'Review the requested modules, preserve existing progress, and verify the result.';
  const controller = await createAgentActorController({ executor: { execute: async () => ({ output: 'unused' }) } });
  const context = { backups: new Map(), actorControl: controller.bind('/root'),
    actorTurnRef: { actorPath: '/root', turnId: 'contract-fixture' } };
  const worker = buildRunnerAgentChain(context, undefined, undefined, undefined,
    { prompt: task, decision: buildFallbackRoutingDecision(task) }).worker;
  markOrdinaryRootToolContract(worker);
  const activeTools = worker.tools?.map(tool => tool.name) ?? [];
  const leaves = createScriptPilot({ ctx: context, events: {}, activeToolNames: activeTools,
    runtimeSessionState: buildRuntimeSessionState({ activeTools, modelSelection: {} }) },
  { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' }, worker).tools;
  const entry = script ? withScriptModelTool(worker, context, leaves, async () => { throw new Error('Never execute during capture'); }) : worker;
  if (script) inheritOrdinaryRootToolContract(worker, entry);
  let captured: FrozenInput | undefined;
  const adapter = buildRunnerLlmAdapter({ provider: 'anthropic' }, async (messages, tools, system) => {
    // This suite replays the historical experiment, not the adopted root prompt.
    // Keep real tool assembly but explicitly reconstruct its pre-adoption Worker.
    // Current production requests are checked in managed-system-contract.test.ts.
    expect(system).toContain('TRUST AND SCOPE');
    captured = { messages, tools, system: instructions(worker) };
    return { textBlocks: [{ text: 'fixture' }], toolBlocks: [] };
  });
  const originalInstructions = instructions(worker);
  try {
    await adapter([{ role: 'system', content: originalInstructions }, { role: 'user', content: task }], entry);
  } finally { await controller.shutdown('Contract fixture finished'); }
  if (!captured) throw new Error('Missing real adapter request');
  return { ...captured, ...(script ? { scriptContracts: getScriptModelContracts(entry, captured.tools) } : {}) };
}

it('uses structured Script contracts to share Worker decisions while retaining the exact execution protocol', async () => {
  const before = await fixture(true);
  expect(before.scriptContracts?.leaves.some(tool => tool.name === 'read')).toBe(true);
  const after = restructuredContractInput(before, true, before.scriptContracts);
  expect(after.system).not.toBe(before.system);
  expect(after.system).toContain('TASK AND PLAN');
  expect(after.tools.find(tool => tool.name === 'script_exec')).toEqual(before.tools.find(tool => tool.name === 'script_exec'));
  expect(after.tools.map(tool => tool.input_schema)).toEqual(before.tools.map(tool => tool.input_schema));
  expect(after.messages).toBe(before.messages);
  expect(restructuredContractInput(before, true)).toBe(before);
  const missingEntry = { ...before, tools: before.tools.filter(tool => tool.name !== 'script_exec') };
  expect(restructuredContractInput(missingEntry, true, before.scriptContracts)).toBe(missingEntry);
  const missingLeaf = { ...before.scriptContracts!, leaves: before.scriptContracts!.leaves.filter(tool => tool.name !== 'read') };
  expect(restructuredContractInput(before, true, missingLeaf)).toBe(before);
  const changed = { ...before, tools: before.tools.map(tool => tool.name === 'script_exec' ? { ...tool, description: tool.description + ' host rule' } : tool) };
  expect(restructuredContractInput(changed, true, before.scriptContracts)).toBe(changed);
});

it('restructures a complete ordinary-root request without changing history, tool menu or parameter structure', async () => {
  const before = await fixture();
  const frozen = structuredClone(before);
  const after = restructuredContractInput(before, true);
  expect(after.system.length, JSON.stringify(before.tools.map(tool => tool.name))).toBeLessThan(before.system.length);
  expect(after.messages).toBe(before.messages);
  expect(after.tools.map(tool => tool.name)).toEqual(before.tools.map(tool => tool.name));
  // This candidate changes descriptions, not even schema annotations.
  expect(after.tools.map(tool => tool.input_schema)).toEqual(before.tools.map(tool => tool.input_schema));
  for (const name of ['ask_user_question', 'undo', 'edit', 'read', 'bash']) {
    expect(after.tools.find(tool => tool.name === name)).toEqual(before.tools.find(tool => tool.name === name));
  }
  expect(before).toEqual(frozen);
});

it('keeps SDK, child, specialist, Script and incomplete/custom composition intact', async () => {
  const before = await fixture();
  expect(restructuredContractInput(before, false)).toBe(before);
  for (const name of ['spawn_agent', 'todo_update', 'send_message']) {
    const missing = { ...before, tools: before.tools.filter(tool => tool.name !== name) };
    expect(restructuredContractInput(missing, true)).toBe(missing);
    const custom = { ...before, tools: before.tools.map(tool => tool.name === name
      ? { ...tool, description: tool.description + ' Host-specific obligation.' } : tool) };
    expect(restructuredContractInput(custom, true)).toBe(custom);
  }
  const custom = { ...before, system: 'Host-defined agent instructions' };
  expect(restructuredContractInput(custom, true)).toBe(custom);
  const script = { ...before, tools: [...before.tools,
    { name: 'script_exec', description: 'Script', input_schema: { type: 'object' as const, properties: {} } }] };
  expect(restructuredContractInput(script, true)).toBe(script);
});

it('keeps historical evaluation inputs replayable while retaining the adopted Todo timing rule', async () => {
  const current = await fixture();
  const names = ['spawn_agent', 'todo_create', 'todo_list', 'todo_update', 'wait_agent'];
  const historical = { ...current, tools: current.tools.map(tool => names.includes(tool.name)
    ? { ...tool, description: getBuiltinToolDefinition(tool.name)!.description } : tool) };
  const oldCandidate = restructuredContractInput(historical, true);
  const newCandidate = restructuredContractInput(current, true);
  expect(oldCandidate.system).not.toBe(historical.system);
  expect(newCandidate.system).toBe(oldCandidate.system);
  expect(oldCandidate.tools.find(tool => tool.name === 'todo_update')!.description).not.toContain('before work');
  expect(newCandidate.tools.find(tool => tool.name === 'todo_update')!.description).toContain('before work');
  expect(newCandidate.tools).toEqual(current.tools);
});

it('retains newly evolved shared rules even when their tool schemas did not change', async () => {
  const before = await fixture();
  const changedMemory = buildMemoryRulesSection('.') + '\nNEW MEMORY AUTHORIZATION RULE';
  const changedManual = SELF_KNOWLEDGE_ROUTING_RULE + '\nNEW MANUAL SOURCE RULE';
  const input = { ...before, system: before.system.replace(buildMemoryRulesSection('.'), '')
    .replace(SELF_KNOWLEDGE_ROUTING_RULE, '') + `\n\n${changedMemory}\n\n${changedManual}` };
  vi.resetModules();
  vi.doMock('../packages/coding/src/prompts/memory-rules.js', () => ({ buildMemoryRulesSection: () => changedMemory }));
  vi.doMock('../packages/coding/src/self-knowledge/routing-rule.js', () => ({ SELF_KNOWLEDGE_ROUTING_RULE: changedManual }));
  try {
    const fresh = await import('./restructured-contract.js');
    const output = fresh.restructuredContractInput(input, true);
    expect(output.system.includes(changedMemory)).toBe(true);
    expect(output.system.includes(changedManual)).toBe(true);
  } finally {
    vi.doUnmock('../packages/coding/src/prompts/memory-rules.js');
    vi.doUnmock('../packages/coding/src/self-knowledge/routing-rule.js');
    vi.resetModules();
  }
});
