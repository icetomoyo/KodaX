import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage,
  type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXHostRuntime } from '../src/sdk-runtime.js';

for (const agentMode of ['sa', 'ama'] as const) for (const kind of ['default', 'markdown'] as const) {
  it(`keeps the actual Host binding catalog bounded and loadable: ${agentMode}/${kind}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kodax-host-binding-catalog-'));
    const workspace = path.join(root, 'workspace');
    const configHome = path.join(root, '.kodax');
    await mkdir(workspace);
    const names = Array.from({ length: 40 }, (_, index) => `audit-${String(index).padStart(2, '0')}`);
    for (const name of names) {
      const directory = path.join(configHome, 'skills', name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${'Inspect detailed catalog evidence. '.repeat(25)}\n---\nBODY_${name}\n`);
    }
    await mkdir(path.join(configHome, 'agents'));
    await writeFile(path.join(configHome, 'agents', 'evidence-agent.md'),
      `---\nname: evidence-agent\ndescription: Inspect evidence\ntools: [read, skill]\nskills: [${names.join(', ')}]\n---\nPROFILE_BOUND\n`);
    const providerName = `host-binding-${agentMode}-${kind}`;
    const requests: { context: string; messages: KodaXMessage[] }[] = [];
    let loaded = false;
    vi.stubEnv('KODAX_HOST_CATALOG_KEY', 'offline-fixture');
    class Provider extends KodaXBaseProvider {
      readonly name = providerName;
      readonly config = { name: providerName, model: 'fixture', apiKeyEnv: 'KODAX_HOST_CATALOG_KEY' };
      async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
        if (tools.some(tool => tool.name === 'commit_episode_learning_review')) {
          return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'review',
            name: 'commit_episode_learning_review', input: { memoryPlan: { actions: [], warnings: [] },
              capabilityDecision: { disposition: 'discard', reasonCodes: ['fixture-no-reusable-method'] } } }] };
        }
        const surfaces = [system, ...messages.flatMap(message => typeof message.content === 'string' ? [message.content]
          : message.content.filter(block => block.type === 'text').map(block => block.text))];
        const context = surfaces.join('\n');
        const primary = tools.some(tool => tool.name === 'skill');
        if (primary) requests.push({ context, messages: structuredClone(messages) });
        const load = primary && !loaded && context.includes('- audit-00:');
        if (load) loaded = true;
        return { textBlocks: load ? [] : [{ type: 'text', text: 'Done.' }], thinkingBlocks: [],
          toolBlocks: load ? [{ type: 'tool_use', id: 'load-audit', name: 'skill', input: { skill: 'audit-00' } }] : [],
          stopReason: load ? 'tool_use' : 'end_turn' };
      }
    }
    registerModelProvider(providerName, () => new Provider());
    const runtime = await createKodaXHostRuntime({ homeDir: root, defaultProvider: providerName });
    const execution = runtime.agents.execution!;
    const owner = await execution.openOwnerSession();
    try {
      const session = await runtime.sessions.create({ projectPath: workspace });
      await runtime.sessions.updateSettings(session.id, { provider: providerName, model: 'fixture', agentMode, permissionMode: 'full-access' });
      const base = { ownerSessionId: owner.ownerSessionId, workspace: { mode: 'fixed' as const, root: workspace },
        toolPolicy: { workspace: 'write' as const, process: 'deny' as const, network: { mode: 'deny' as const },
          tools: [], mcp: {}, skillScripts: {}, subagents: 'deny' as const } };
      const binding = kind === 'default' ? await execution.bindDefault(base)
        : await execution.bindLocal({ ...base, ref: { source: 'markdown:user', name: 'evidence-agent' } });
      const request = { ownerSessionId: owner.ownerSessionId, bindingId: binding.bindingId,
        expectedExecutionPolicyRevision: binding.executionPolicyRevision, sessionId: session.id,
        input: { type: 'text' as const, text: 'Inspect evidence.' } };
      const run = 'configurationRevision' in binding
        ? await execution.startLocal({ ...request, expectedConfigurationRevision: binding.configurationRevision })
        : await execution.startDefault(request);
      expect((await run.result).phase).toBe('completed');
      expect(requests[0]?.context).toContain('- audit-00:');
      const catalog = /## Available Skills\n[\s\S]*?\[Skill catalog shortened:[^\n]*\]/.exec(requests[0]!.context)?.[0];
      expect(catalog).toBeDefined();
      expect(catalog!.length).toBeLessThanOrEqual(8_000);
      expect(catalog).not.toContain('- audit-39:');
      if (kind === 'markdown') expect(requests[0]!.context.split('PROFILE_BOUND')).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.messages)).toContain('BODY_audit-00');
      expect(binding.effectiveSkills.filter(skill => names.includes(skill.name))).toHaveLength(40);
    } finally {
      try { await execution.closeOwnerSession(owner.ownerSessionId); }
      finally {
        try { await runtime.close(); }
        finally {
          vi.unstubAllEnvs();
          expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
      }
    }
  });
}
