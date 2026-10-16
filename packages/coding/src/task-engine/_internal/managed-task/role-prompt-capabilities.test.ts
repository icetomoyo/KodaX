import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentActorController, Runner, setAgentConfigHome } from '@kodax-ai/agent';
import type { KodaXOptions } from '../../../types.js';
import { runManagedTaskViaRunner } from '../../runner-driven.js';
import { buildFallbackRoutingDecision } from '../../../reasoning.js';
import { buildRunnerAgentChain } from './agent-chain.js';

let fixtureRoot: string;
let workspace: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-prompt-capabilities-'));
  workspace = path.join(fixtureRoot, 'workspace');
  await mkdir(workspace);
  setAgentConfigHome(path.join(fixtureRoot, 'home'));
});

afterAll(async () => {
  setAgentConfigHome(undefined);
  if (fixtureRoot && path.dirname(fixtureRoot) === path.resolve(os.tmpdir())) {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('managed Worker prompt capability wiring', () => {
  it.each([[], ['todo_update', 'send_message']])('keeps partial standalone responsibilities for tools %j', async (...toolNames: string[]) => {
    const chain = buildRunnerAgentChain({
      backups: new Map<string, string>(), gitRoot: workspace, executionCwd: workspace,
      actorControl: (await createAgentActorController({ executor: { execute: async () => { throw new Error('Prompt fixture must not spawn'); } } })).bind('/root'),
      toolVisibilityPolicy: ({ name }) => toolNames.includes(name),
    });
    await Runner.run(chain.worker, 'Continue the requested work.', { tracer: null,
      llm: async (messages, agent) => {
        expect(agent.tools?.map(tool => tool.name).sort()).toEqual([...toolNames].sort());
        const system = JSON.stringify(messages.filter(message => message.role === 'system'));
        expect(system).not.toContain('todo_create');
        expect(system).not.toContain('spawn_agent');
        expect(system).not.toContain('wait_agent');
        expect(system).toContain('reuse existing progress on resume');
        expect(system).toContain('unresolved ownership');
        for (const name of toolNames) expect(system).toContain(`\`${name}\``);
        return 'Done.';
      },
    });
  });

  it.each(['root', 'child'] as const)('restricts the standalone %s chain fallback at the real Runner LLM seam', async (role) => {
    const chain = buildRunnerAgentChain({
      backups: new Map<string, string>(), gitRoot: workspace, executionCwd: workspace,
      toolVisibilityPolicy: ({ name }) => name === 'read',
      ...(role === 'child' ? { currentAgentId: '/root/child', parentAgentId: '/root' } : {}),
    });
    let capturedSystem = '';
    await Runner.run(chain.worker, 'Inspect the requested file.', { tracer: null,
      llm: async (messages, agent) => {
        expect(agent.tools?.map(tool => tool.name)).toEqual(['read']);
        capturedSystem = JSON.stringify(messages.filter(message => message.role === 'system'));
        return 'Inspection complete.';
      },
    });
    expect(capturedSystem).toContain('read');
    expect(capturedSystem).toContain('Available tools: read.');
    for (const unavailable of ['todo_create', 'todo_update', 'spawn_agent', 'wait_agent', 'send_message', 'exit_plan_mode']) {
      expect(capturedSystem).not.toContain(unavailable);
    }
    expect(capturedSystem).toContain('Verify');
  });

  it.each(['root', 'child'] as const)('uses the %s executable tool set before the first provider call', async (role) => {
    const stop = new Error('captured first provider request');
    let capturedSystem = '';
    let capturedNames: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: {
        executionCwd: workspace,
        gitRoot: workspace,
        managedTaskWorkspaceDir: workspace,
        repoIntelligenceMode: 'off',
        toolVisibilityPolicy: ({ name }) => ['read', 'grep', 'module_context'].includes(name),
        ...(role === 'child' ? {
          currentAgentId: '/root/review-child',
          parentAgentId: '/root',
          systemPromptOverride: 'Read-only child: inspect only the requested module.',
        } : {}),
      },
    };
    await expect(runManagedTaskViaRunner(options, 'Review only the requested module.', async (_messages, tools, system) => {
      capturedSystem = system;
      capturedNames = tools.map((tool) => tool.name);
      // Stop before tool execution, finalization, or any subsequent generation.
      throw stop;
    }, {
      effort: 'medium',
      decision: buildFallbackRoutingDecision('Review only the requested module.'),
      promptOverlay: '',
    })).rejects.toBe(stop);

    expect(capturedNames).toEqual(expect.arrayContaining(['read', 'grep', 'module_context']));
    expect(capturedNames).not.toContain('changed_scope');
    expect(capturedSystem).toContain('`module_context`');
    expect(capturedSystem).not.toContain('`changed_scope`');
    expect(capturedSystem).not.toContain('`relationship_scan`');
    for (const unavailable of ['todo_create', 'todo_update', 'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'interrupt_agent', 'list_agents', 'agent_output']) {
      expect(capturedSystem.includes(unavailable), `unavailable ${unavailable}`).toBe(false);
    }
    expect(capturedSystem).toContain('requested scope');
    expect(capturedSystem).toContain('read/grep');
  });
});
