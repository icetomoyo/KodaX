import { expect, it } from 'vitest';
import type { FrozenInput } from './first-turn-eval-support.js';
import { restructuredContractInput } from './restructured-contract.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { getScriptModelContracts, withScriptModelTool } from '../packages/coding/src/agent-runtime/script/model.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { createAgentActorController } from '../packages/agent/src/actors/index.js';
import type { Agent } from '@kodax-ai/agent';

const instructions = (agent: Agent) => typeof agent.instructions === 'function' ? agent.instructions(undefined) : agent.instructions;

async function fixture(script = false): Promise<FrozenInput & { scriptContracts?: ReturnType<typeof getScriptModelContracts> }> {
  const task = 'Review the requested modules, preserve existing progress, and verify the result.';
  const controller = await createAgentActorController({ executor: { execute: async () => ({ output: 'unused' }) } });
  const context = { backups: new Map(), actorControl: controller.bind('/root'),
    actorTurnRef: { actorPath: '/root', turnId: 'contract-fixture' } };
  const worker = buildRunnerAgentChain(context, undefined, undefined, undefined,
    { prompt: task, decision: buildFallbackRoutingDecision(task) }).worker;
  const activeTools = worker.tools?.map(tool => tool.name) ?? [];
  const leaves = createScriptPilot({ ctx: context, events: {}, activeToolNames: activeTools,
    runtimeSessionState: buildRuntimeSessionState({ activeTools, modelSelection: {} }) },
  { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' }, worker).tools;
  const entry = script ? withScriptModelTool(worker, context, leaves, async () => { throw new Error('Never execute during capture'); }) : worker;
  let captured: FrozenInput | undefined;
  const adapter = buildRunnerLlmAdapter({ provider: 'anthropic' }, async (messages, tools, system) => {
    // Current production requests are checked in worker-system-contract.test.ts.
    expect(system).toContain('TRUST AND SCOPE');
    captured = { messages, tools, system };
    return { textBlocks: [{ text: 'fixture' }], toolBlocks: [] };
  });
  const originalInstructions = instructions(worker);
  try {
    await adapter([{ role: 'system', content: originalInstructions }, { role: 'user', content: task }], entry);
  } finally { await controller.shutdown('Contract fixture finished'); }
  if (!captured) throw new Error('Missing real adapter request');
  const scriptContracts = script ? getScriptModelContracts(entry, captured.tools) : undefined;
  return { ...captured, ...(scriptContracts ? { scriptContracts } : {}) };
}

it('does not apply the frozen historical projector to newly evolved production tool contracts', async () => {
  const current = await fixture();
  expect(restructuredContractInput(current, true)).toBe(current);
});

it('shares current Worker decisions while preserving the discoverable native bridge and Script control protocol', async () => {
  const ordinary = await fixture();
  const script = await fixture(true);
  // Script mode keeps the shared Worker prefix and appends where its file tools live,
  // because the shared text names read/edit/grep as if they were native.
  expect(script.system.startsWith(`${ordinary.system}\n\nSCRIPT MODE\n`)).toBe(true);
  expect(script.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['tool_call', 'script_exec', 'script_wait']));
  expect(script.scriptContracts?.entry.description).toContain('Native tool_call({name,input})');
  expect(script.scriptContracts?.entry.input_schema.properties).toMatchObject({
    selected_output: { type: 'boolean' }, yield_time_ms: { type: 'integer' }, code: { type: 'string' },
  });
  expect(script.tools.find(tool => tool.name === 'script_exec')).toEqual(script.scriptContracts?.entry);
  expect(restructuredContractInput(script, true, script.scriptContracts)).toBe(script);
});

