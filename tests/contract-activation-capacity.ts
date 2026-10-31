/** Offline P06-derived root checkpoint: actual Actor metadata/refusal, then the real request adapter. */
import path from 'node:path';
import { createAgentActorController } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import { writeCacheFixture, CACHE_FILES } from '../benchmark/datasets/search-entry-complex/fixture.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { toolListAgents, toolSpawnAgent } from '../packages/coding/src/tools/agent-collaboration.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { markOrdinaryRootToolContract } from '../packages/coding/src/tools/managed-tool-contract.js';
import { markRegistryManagedAgent } from '../packages/coding/src/tools/model-tool-definition.js';
import { createManagedRunContextMessage } from '../packages/coding/src/task-engine/_internal/managed-task/managed-run-context.js';
import { buildWorkerActorCapacityContract, buildWorkerRoutingContext } from '../packages/coding/src/agents/worker-role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

export const CAPACITY_RECOVERY_TASK = '继续调查；请让现有 inspect-child 补充核对零 TTL 是否立即失效。你继续核对公开入口，先不要修改文件。';

export async function prepareActivationCapacityPair(directory: string, baseline: FrozenInput, candidate: FrozenInput) {
  const workspace = path.join(directory, 'capacity-workspace');
  await writeCacheFixture(workspace);
  const align = (input: FrozenInput) => {
    if ([...input.system.matchAll(/^Working Directory: [^\r\n]+/gm)].length !== 1) throw new Error('Expected one captured Environment working directory');
    return { ...input, system: input.system.replace(/^Working Directory: [^\r\n]+/m, () => `Working Directory: ${workspace}`) };
  };
  const alignedBaseline = align(baseline), alignedCandidate = align(candidate);
  const controller = await createAgentActorController({ executor: { execute: input => new Promise<{ output: string }>(resolve => {
    const finish = () => resolve({ output: 'Offline preparation cleanup; no model or file operation.' });
    if (input.signal.aborted) finish(); else input.signal.addEventListener('abort', finish, { once: true });
  }) } });
  try {
    const client = controller.bind('/root');
    const context: KodaXToolExecutionContext = { backups: new Map(), actorControl: client,
      actorTurnRef: { actorPath: '/root', turnId: 'activation-capacity-fixture' }, executionCwd: workspace };
    const admissions = [];
    for (const [task_name, objective] of [['inspect-child', '只读核对 packages/cache/store.js 的 TTL 行为'],
      ['identity-review', '只读核对 packages/identity 的编码'], ['client-review', '只读核对 packages/client 的缓存行为']] as const) {
      const result = await toolSpawnAgent({ task_name, objective, read_only: true }, context);
      if ((JSON.parse(result) as { ok?: boolean }).ok !== true) throw new Error('Offline child admission failed');
      admissions.push(result);
    }
    const snapshot = client.list(), inspectChild = snapshot.actors.find(actor => actor.path === '/root/inspect-child');
    if (snapshot.activeNonRootTurns !== 3 || snapshot.maxConcurrentThreads !== 4 || inspectChild?.capabilities.filesystem !== 'read') throw new Error('Invalid actual capacity/child provenance');
    const listed = await toolListAgents({}, context);
    const spawnInput = { task_name: 'extra', objective: '补充核对零 TTL', read_only: true };
    const denial = await toolSpawnAgent(spawnInput, context);
    const refused = JSON.parse(denial) as { ok: boolean; error: { code: string; activeNonRootTurns: number } };
    if (refused.ok || refused.error.code !== 'agent_limit_reached' || refused.error.activeNonRootTurns !== 3) throw new Error('Expected original full-capacity refusal');
    const required = ['spawn_agent', 'list_agents', 'followup_task', 'read'];
    if (required.some(name => !baseline.tools.some(tool => tool.name === name) || !candidate.tools.some(tool => tool.name === name))) throw new Error('Missing captured root collaboration contract');
    const capacity = buildWorkerActorCapacityContract(snapshot, candidate.tools.map(tool => tool.name));
    if (!capacity) throw new Error('Missing canonical capacity builder');
    const envelope = ['=== Managed Run Context ===', `Session Scratch Directory: ${path.join(workspace, '.agent/tmp/sessions/activation-capacity')}`, capacity,
      buildWorkerRoutingContext(buildFallbackRoutingDecision(CAPACITY_RECOVERY_TASK)),
      `Project: ${workspace}\n${Object.keys(CACHE_FILES).sort().map(file => `  ${file}`).join('\n')}`,
      'Existing investigation remains in progress. All three listed children are active read-only lanes; no source has changed. Continue the root public-entry lane while updating the existing TTL lane as useful.',
      '=== End Managed Run Context ==='].join('\n\n');
    const messages: KodaXMessage[] = [createManagedRunContextMessage(envelope), { role: 'user', content: CAPACITY_RECOVERY_TASK },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'capacity-list', name: 'list_agents', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capacity-list', content: listed }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'capacity-denied-spawn', name: 'spawn_agent', input: spawnInput }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capacity-denied-spawn', content: denial, is_error: true }] }];
    const saved = structuredClone(messages);
    const agent = markRegistryManagedAgent({ ...buildRunnerAgentChain(context).worker, tools: [...candidate.tools] }, context);
    markOrdinaryRootToolContract(agent);
    let projected: readonly KodaXMessage[] | undefined, requests = 0, adapterToolNames: string[] = [];
    await buildRunnerLlmAdapter({ provider: 'anthropic', reasoningMode: 'off' }, async (wire, tools) => {
      requests++; projected = structuredClone(wire);
      adapterToolNames = tools.map(tool => tool.name);
      return { textBlocks: [{ text: 'Offline request projection only; original task not executed.' }], toolBlocks: [] };
    })([{ role: 'system', content: alignedCandidate.system }, ...messages], agent);
    if (requests !== 1 || !projected || inputHash(messages) !== inputHash(saved)) throw new Error('Adapter must project exactly once without changing canonical state');
    if (!String(projected[0]?.content).includes('Snapshot: 3 active non-root turns; 0 child start slots available')
      || String(projected[0]?.content).includes('At this prompt snapshot')) throw new Error('Actual adapter did not apply candidate capacity contract');
    if (inputHash(projected.slice(1)) !== inputHash(messages.slice(1))) throw new Error('Capacity projection changed task or original refusal');
    const facts = { snapshot, inspectChild, admissions, listed, denial, workspace, adapterToolNames,
      environmentProjection: { baselineBefore: inputHash(baseline.system), baselineAfter: inputHash(alignedBaseline.system),
        candidateBefore: inputHash(candidate.system), candidateAfter: inputHash(alignedCandidate.system), rule: 'Replace exactly one captured Working Directory line with the actual common fixture cwd; all other system text stays captured.' } };
    return { baseline: { ...alignedBaseline, messages }, candidate: { ...alignedCandidate, messages: projected }, facts,
      factHash: inputHash(facts), canonicalMessagesHash: inputHash(messages), projectedMessagesHash: inputHash(projected), externalModelCalls: 0,
      scope: 'capture-derived controlled root checkpoint: actual retained/candidate root system/tools, production canonical capacity builder, real list/spawn metadata/refusal, one actual candidate adapter message projection. Not original Runtime wire, a complete task or a child-internal edit-refusal test.' };
  } finally { await controller.shutdown('Offline capacity checkpoint frozen; no model called'); }
}
