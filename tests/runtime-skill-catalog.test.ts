import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Runner, SkillRegistry } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage,
  type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { runKodaX } from '../packages/coding/src/agent.js';
import { runManagedTask } from '../packages/coding/src/task-engine.js';
import { createDefaultCodingAgent } from '../packages/coding/src/coding-preset.js';
import type { KodaXOptions } from '../packages/coding/src/types.js';
import { createRuntimeAgentBindingService } from '../src/runtime-agent-binding.js';

const roots: string[] = [];
let sequence = 0;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

it.each(['sa', 'managed-sa', 'ama', 'runner'] as const)('keeps an admitted Skill discoverable under Markdown/profile instructions in %s', async mode => {
  const root = await mkdtemp(path.join(tmpdir(), 'kodax-profile-catalog-'));
  roots.push(root);
  const configHome = path.join(root, '.kodax');
  const skillsRoot = path.join(configHome, 'skills');
  for (const [name, disabled] of [['audit-evidence', false], ['private-skill', true], ['unselected-skill', false]] as const) {
    const directory = path.join(skillsRoot, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Inspect project evidence\n${disabled ? 'disable-model-invocation: true\n' : ''}---\nBODY_${name}\n`);
  }
  await mkdir(path.join(configHome, 'agents'));
  await writeFile(path.join(configHome, 'agents', 'evidence-agent.md'),
    '---\nname: evidence-agent\ndescription: Inspect evidence\ntools: [read, skill]\nskills: [audit-evidence]\n---\nPROFILE_INSTRUCTIONS\n');
  const registry = new SkillRegistry(root, { projectPaths: [skillsRoot], userPaths: [], pluginPaths: [], builtinPath: path.join(root, 'none') });
  await registry.discover();
  const name = `profile-catalog-${++sequence}`;
  const requests: { system: string; tools: string[]; messages: KodaXMessage[] }[] = [];
  vi.stubEnv('KODAX_PROFILE_CATALOG_KEY', 'offline-fixture');
  class Provider extends KodaXBaseProvider {
    readonly name = name;
    readonly config = { name, model: 'fixture', apiKeyEnv: 'KODAX_PROFILE_CATALOG_KEY' };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      requests.push({ system, tools: tools.map(tool => tool.name), messages: structuredClone(messages) });
      const load = requests.length === 1 && `${system}\n${JSON.stringify(messages)}`.includes('- audit-evidence:');
      return { textBlocks: load ? [] : [{ type: 'text', text: 'Done.' }], thinkingBlocks: [],
        toolBlocks: load ? [{ type: 'tool_use', id: 'load-evidence', name: 'skill', input: { skill: 'audit-evidence' } }] : [],
        stopReason: load ? 'tool_use' : 'end_turn' };
    }
  }
  registerModelProvider(name, () => new Provider());
  const execute = async (options: KodaXOptions) => {
    const scoped: KodaXOptions = { ...options, provider: name, reasoningMode: 'off', maxIter: 3,
      context: { ...options.context, configHome, gitRoot: root, executionCwd: root, repoIntelligenceMode: 'off' } };
    if (mode === 'runner') return (await Runner.run(createDefaultCodingAgent(), 'Inspect evidence.', { presetOptions: scoped })).data;
    return mode === 'sa' ? runKodaX(scoped, 'Inspect evidence.')
      : runManagedTask({ ...scoped, agentMode: mode === 'managed-sa' ? 'sa' : 'ama' }, 'Inspect evidence.');
  };
  for (const entry of ['binding', 'sdk-profile'] as const) {
    requests.length = 0;
    if (entry === 'binding') {
      const service = createRuntimeAgentBindingService({ configHome, managedWorkspaceRoot: path.join(root, 'managed'),
        defaultProvider: name, defaultModel: 'fixture', sessions: { load: async id => ({ id, title: '', workspaceRoot: root }) },
        runs: { start: async input => {
          await execute(input.options!);
          return { runId: 'fixture', sessionId: input.sessionId,
            result: Promise.resolve({ runId: 'fixture', sessionId: input.sessionId, phase: 'completed' as const }) };
        } } });
      const owner = await service.openOwnerSession();
      try {
        const binding = await service.bindLocal({ ownerSessionId: owner.ownerSessionId,
          ref: { source: 'markdown:user', name: 'evidence-agent' }, workspace: { mode: 'fixed', root },
          toolPolicy: { workspace: 'write', process: 'deny', network: { mode: 'deny' }, tools: [], mcp: {}, skillScripts: {}, subagents: 'deny' } });
        await (await service.startLocal({ ownerSessionId: owner.ownerSessionId, bindingId: binding.bindingId,
          expectedConfigurationRevision: binding.configurationRevision, expectedExecutionPolicyRevision: binding.executionPolicyRevision,
          sessionId: 'profile-session', input: { type: 'text', text: 'Inspect evidence.' } })).result;
      } finally { await service.closeOwnerSession(owner.ownerSessionId); }
    } else await execute({ provider: name, context: { skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet(),
      agentProfile: { instructions: 'PROFILE_INSTRUCTIONS', verification: {
        summary: 'PROFILE_VERIFY', requiredEvidence: ['PROFILE_EVIDENCE'] } },
      taskVerification: { summary: 'TASK_VERIFY', requiredChecks: ['TASK_CHECK'] } } });
    expect(requests[0]!.system, entry).toContain('PROFILE_INSTRUCTIONS');
    expect(requests[0]!.tools).toContain('skill');
    // AMA carries capability catalogs in request messages, while SA uses system.
    const modelContext = `${requests[0]!.system}\n${JSON.stringify(requests[0]!.messages)}`;
    expect(modelContext, entry).toContain('- audit-evidence:');
    expect(modelContext).not.toContain('- private-skill:');
    if (entry === 'binding') expect(modelContext).not.toContain('- unselected-skill:');
    else {
      expect(modelContext).toContain('TASK_VERIFY');
      expect(modelContext).toContain('PROFILE_EVIDENCE');
      expect(modelContext).toContain('TASK_CHECK');
      expect(modelContext).toContain('EXECUTION GUIDANCE (match your approach');
    }
    expect(JSON.stringify(requests[1]?.messages), entry).toContain('BODY_audit-evidence');
    expect(requests[0]!.system.split('PROFILE_INSTRUCTIONS')).toHaveLength(2);
  }
  requests.length = 0;
  const profileContext = { skillRegistry: registry, skillsPrompt: registry.getSystemPromptSnippet(),
    agentProfile: { instructions: 'PROFILE_INSTRUCTIONS' } };
  await execute({ provider: name, context: { ...profileContext, excludeTools: ['skill'] } });
  expect(requests[0]!.tools).not.toContain('skill');
  expect(`${requests[0]!.system}\n${JSON.stringify(requests[0]!.messages)}`).not.toContain('- audit-evidence:');
  expect(requests[0]!.system).toContain('PROFILE_INSTRUCTIONS');
  if (mode !== 'ama') {
    requests.length = 0;
    await execute({ provider: name, context: { ...profileContext, systemPromptOverride: 'COMPLETE_CALLER_OVERRIDE' } });
    expect(requests[0]!.system).toBe('COMPLETE_CALLER_OVERRIDE');
  }
});
