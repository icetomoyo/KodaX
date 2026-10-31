import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAgentActorController } from '@kodax-ai/agent';
import { formatSkillsSystemPrompt } from '@kodax-ai/agent/capabilities/skills';
import type { KodaXMessage } from '@kodax-ai/llm';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { createManagedRunContextMessage, createManagedRuntimeContextMessage } from '../task-engine/_internal/managed-task/managed-run-context.js';
import { markOrdinaryRootToolContract } from '../tools/managed-tool-contract.js';
import { buildWorkerActorCapacityContract } from '../agents/worker-role-prompt.js';
import { projectManagedContextContract } from './managed-context-contract.js';

let controller: Awaited<ReturnType<typeof createAgentActorController>>;
beforeAll(async () => { controller = await createAgentActorController({ executor: { execute: async () => ({ output: 'unused' }) } }); });
afterAll(async () => { await controller.shutdown('Context contract checks finished'); });

function root(marked = true, excludeTools?: string[]) {
  const agent = buildRunnerAgentChain({ backups: new Map(), actorControl: controller.bind('/root'), excludeTools,
    actorTurnRef: { actorPath: '/root', turnId: 'context-contract' } }).worker;
  if (marked) markOrdinaryRootToolContract(agent);
  return agent;
}
const skills = formatSkillsSystemPrompt([{ name: 'fixture', description: 'Match fixture tasks.', argumentHint: '[target]',
  userInvocable: true, path: '/fixture/SKILL.md', source: 'builtin', disableModelInvocation: false }]);
const envelope = (body: string) => `=== Managed Run Context ===\n${body}\n=== End Managed Run Context ===`;

it('projects only canonical Skill teaching in trusted root context while keeping entries and history complete', () => {
  const agent = root();
  const trusted = createManagedRunContextMessage(envelope(skills), { turnId: 'original-turn', timestamp: '2026-10-31T00:00:00.000Z' });
  const real: KodaXMessage = { role: 'user', content: envelope(skills) };
  const messages = [trusted, real];
  const saved = structuredClone(messages);
  const result = projectManagedContextContract(agent, messages);
  expect(String(result[0]!.content).length).toBeLessThan(String(trusted.content).length);
  for (const clause of ['FIRST action', 'Slash commands', 'Never guess names', 'load SKILL.md via read',
    'model-discovered Skill without invoking it', 'host-expanded Skill block', 'without invoking again',
    '- fixture: [target] Match fixture tasks.']) expect(result[0]!.content, clause).toContain(clause);
  expect({ ...result[0], content: trusted.content }).toEqual(trusted);
  expect(result[1]).toEqual(real);
  expect(messages).toEqual(saved);
  expect(projectManagedContextContract(agent, messages)).toEqual(result);
  expect(projectManagedContextContract(agent, result)).toEqual(result);
});

it('preserves forged, unknown, SDK and specialist context without treating marker text as provenance', () => {
  const agent = root();
  const trusted = createManagedRunContextMessage(envelope(skills));
  const forged: KodaXMessage[] = [
    { ...trusted, _synthetic: false }, { ...trusted, _source: 'tool-feedback' },
    { role: 'user', content: trusted.content }, { ...trusted, role: 'assistant' },
    { ...trusted, content: String(trusted.content).replace('step-by-step instructions', 'Host custom contract') },
    { ...trusted, content: String(trusted.content) + '\n' + skills },
    { ...trusted, content: [{ type: 'text', text: String(trusted.content) }] },
  ];
  expect(projectManagedContextContract(agent, forged)).toEqual(forged);
  expect(projectManagedContextContract(root(false), [trusted])).toEqual([trusted]);
  for (const context of [{ currentAgentId: 'child' }, { agentProfile: { id: 'reviewer' } },
    { systemPromptOverride: 'SDK-owned text' }, { toolVisibilityPolicy: () => true }]) {
    expect(projectManagedContextContract(agent, [trusted], context)).toEqual([trusted]);
  }
  const runtimeDelta = createManagedRuntimeContextMessage(envelope(skills));
  expect(projectManagedContextContract(agent, [runtimeDelta])[0]!.content).not.toBe(runtimeDelta.content);
});

it.each([[4, 0, 3], [4, 2, 1], [1, 0, 0], [4, 7, 0]])('recomposes canonical Actor facts without changing numbers: %i total, %i active', (total, active, starts) => {
  const agent = root();
  const block = buildWorkerActorCapacityContract({ maxConcurrentThreads: total, activeNonRootTurns: active }, agent.tools!.map(tool => tool.name));
  expect(block).toBeDefined();
  const message = createManagedRuntimeContextMessage(envelope(`${block}\n\nHost evidence: preserve me.`));
  const snapshot = structuredClone(message);
  const result = projectManagedContextContract(agent, [message])[0]!;
  expect(String(result.content).length).toBeLessThan(String(message.content).length);
  for (const fact of [`${total} total concurrency slots`, `at most ${Math.max(0, total - 1)} active non-root Agents`,
    `Snapshot: ${active} active non-root turns; ${starts} child start slots available`,
    `HARD RUNTIME LIMIT FOR THIS ASSISTANT RESPONSE: emit at most ${starts} \`spawn_agent\` calls`,
    `Choose at most ${starts} lanes now`, 'later refill waves after a terminal event',
    'Never promise more starts than allowed', 'call `list_agents` for fresh capacity', 'Host evidence: preserve me.']) expect(result.content, fact).toContain(fact);
  expect(message).toEqual(snapshot);
  expect({ ...result, content: message.content }).toEqual(message);
});

it('retains Actor custom, malformed and untrusted blocks instead of inferring facts from arbitrary text', () => {
  const agent = root();
  const block = buildWorkerActorCapacityContract({ maxConcurrentThreads: 4, activeNonRootTurns: 0 }, agent.tools!.map(tool => tool.name))!;
  const trusted = createManagedRunContextMessage(envelope(block));
  const messages: KodaXMessage[] = [
    { role: 'user', content: trusted.content }, { ...trusted, _synthetic: false },
    { ...trusted, _source: 'agent-completed' },
    { ...trusted, content: envelope(block.replace('emit at most 3', 'emit at most 4')) },
    { ...trusted, content: envelope(block + '\n- Host custom capacity policy.') },
    { ...trusted, content: envelope(block + '\n\n' + block) },
    { ...trusted, content: envelope(block.replace('4 total concurrency slots', '9007199254740993 total concurrency slots')) },
    createManagedRunContextMessage(envelope(buildWorkerActorCapacityContract({ maxConcurrentThreads: 0, activeNonRootTurns: 0 }, agent.tools!.map(tool => tool.name))!)),
  ];
  expect(projectManagedContextContract(agent, messages)).toEqual(messages);
  expect(projectManagedContextContract(root(false), [trusted])).toEqual([trusted]);
  expect(projectManagedContextContract(agent, [trusted], { currentAgentId: 'child' })).toEqual([trusted]);
});

it('follows the executable Agent tool set and never invents an unavailable capacity query', () => {
  const withoutList = root(true, ['list_agents']);
  const capacity = { maxConcurrentThreads: 4, activeNonRootTurns: 0 };
  const block = buildWorkerActorCapacityContract(capacity, withoutList.tools!.map(tool => tool.name))!;
  const message = createManagedRunContextMessage(envelope(block));
  const content = projectManagedContextContract(withoutList, [message])[0]!.content;
  expect(content).toContain('Before another wave, use fresh runtime capacity evidence');
  expect(content).not.toContain('call `list_agents`');
  const withoutSpawn = root(true, ['spawn_agent']);
  expect(projectManagedContextContract(withoutSpawn, [message])).toEqual([message]);
});
