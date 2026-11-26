import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createAgent,
  type ToolGuardrail,
} from '@kodax-ai/agent';
import { registerTool } from '@kodax-ai/coding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRuntimeAgentBindingService,
  type RuntimeAgentBindingHost,
  type RuntimeBoundDefaultAgent,
  type RuntimeExecutionToolPolicy,
} from './runtime-agent-binding.js';
import type { RuntimeRunResult, RuntimeStartRunInput } from './sdk-runtime.js';

let home: string;
let workspace: string;
let starts: RuntimeStartRunInput[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'kodax-runtime-agent-'));
  workspace = path.join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  starts = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function policy(overrides: Partial<RuntimeExecutionToolPolicy> = {}): RuntimeExecutionToolPolicy {
  return {
    workspace: 'write',
    process: 'deny',
    network: { mode: 'deny' },
    tools: [],
    mcp: {},
    skillScripts: {},
    subagents: 'deny',
    ...overrides,
  };
}

function writeAgent(input: {
  readonly tools: string;
  readonly skills: string;
  readonly provider?: string;
}): void {
  const dir = path.join(home, '.kodax', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'office-agent.md'), [
    '---',
    'name: office-agent',
    'description: Completes office tasks',
    `tools: ${input.tools}`,
    `skills: ${input.skills}`,
    'model: bound-model',
    ...(input.provider ? [`provider: ${input.provider}`] : []),
    'effort: high',
    '---',
    'You are a general office agent.',
  ].join('\n'));
}

function writeSkill(): void {
  const dir = path.join(home, '.kodax', 'skills', 'office-reports');
  mkdirSync(path.join(dir, 'references'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: office-reports',
    'description: Create office reports',
    '---',
    'Follow the reporting workflow.',
  ].join('\n'));
  writeFileSync(path.join(dir, 'references', 'format.md'), 'Pinned format.');
  writeFileSync(path.join(dir, 'scripts', 'render.mjs'), 'process.stdout.write("rendered")');
}

function host(): RuntimeAgentBindingHost {
  return {
    configHome: path.join(home, '.kodax'),
    managedWorkspaceRoot: path.join(home, 'kodax_a2a_server_workspace'),
    defaultProvider: 'test-provider',
    defaultModel: 'test-model',
    sessions: {
      async load(sessionId) {
        return { id: sessionId, title: '', workspaceRoot: workspace };
      },
    },
    runs: {
      async start(input) {
        starts.push(input);
        return {
          runId: 'run-1',
          sessionId: input.sessionId,
          result: Promise.resolve({ runId: 'run-1', sessionId: input.sessionId, phase: 'completed' }),
        };
      },
    },
  };
}

describe('FEATURE_267 Runtime local Agent binding', () => {
  it.each(['default', 'local'] as const)('bounds the %s catalog while retaining the authorized registry', async kind => {
    const names = Array.from({ length: 40 }, (_, index) => `catalog-${String(index).padStart(2, '0')}`);
    for (const name of names) {
      const directory = path.join(home, '.kodax', 'skills', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${'Inspect detailed catalog evidence. '.repeat(25)}\n---\nBODY_${name}\n`);
    }
    writeAgent({ tools: '[read, skill]', skills: `[${names.join(', ')}]` });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    try {
      const base = { ownerSessionId: owner.ownerSessionId,
        workspace: { mode: 'fixed' as const, root: workspace }, toolPolicy: policy() };
      const binding = kind === 'default' ? await service.bindDefault(base)
        : await service.bindLocal({ ...base, ref: { source: 'markdown:user', name: 'office-agent' } });
      const request = { ownerSessionId: owner.ownerSessionId, bindingId: binding.bindingId,
        expectedExecutionPolicyRevision: binding.executionPolicyRevision,
        sessionId: 'bounded-catalog', input: { type: 'text' as const, text: 'Inspect evidence.' } };
      if ('configurationRevision' in binding && typeof binding.configurationRevision === 'string') {
        await service.startLocal({ ...request, expectedConfigurationRevision: binding.configurationRevision });
      } else await service.startDefault(request);
      const context = starts[0]!.options!.context!;
      expect(context.skillsPrompt!.length).toBeLessThanOrEqual(8_000);
      expect(context.skillsPrompt).toContain('Skills not listed');
      expect(context.skillsPrompt).not.toContain('- catalog-39:');
      expect(context.skillRegistry!.has('catalog-39')).toBe(true);
      expect((await context.skillRegistry!.loadFull('catalog-39')).content).toContain('BODY_catalog-39');
      expect(binding.effectiveSkills.filter(skill => names.includes(skill.name))).toHaveLength(40);
      await expect(context.skillRegistry!.reload()).rejects.toThrow('immutable');
    } finally { await service.closeOwnerSession(owner.ownerSessionId); }
  });

  it.each([true, false])('preserves discovery uncertainty through bound registries (wildcard=%s)', async wildcard => {
    writeAgent({ tools: '[read, skill]', skills: wildcard ? '["*"]' : '[office-reports]' });
    writeSkill();
    mkdirSync(path.join(workspace, '.kodax'), { recursive: true });
    writeFileSync(path.join(workspace, '.kodax', 'skills'), 'Invalid trusted source');
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    try {
      const binding = await service.bindLocal({ ownerSessionId: owner.ownerSessionId,
        ref: { source: 'markdown:user', name: 'office-agent' }, workspace: { mode: 'fixed', root: workspace }, toolPolicy: policy() });
      await service.startLocal({ ownerSessionId: owner.ownerSessionId, bindingId: binding.bindingId,
        expectedConfigurationRevision: binding.configurationRevision,
        expectedExecutionPolicyRevision: binding.executionPolicyRevision, sessionId: 'bound-skills',
        input: { type: 'text', text: 'Use bound Skills.' } });
      const registry = starts[0]?.options?.context?.skillRegistry;
      expect(registry?.discoveryIncomplete).toBe(wildcard);
      expect(registry?.has('office-reports')).toBe(true);
      expect(registry?.has('draft-response')).toBe(false);
    } finally { await service.closeOwnerSession(owner.ownerSessionId); }
  });

  it('pins a user Markdown Agent, selected Skills, tools, and run options', async () => {
    writeAgent({
      tools: '[read, grep, write, skill]',
      skills: '[office-reports]',
      provider: 'bound-provider',
    });
    writeSkill();
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });

    expect(binding.effectiveTools).toEqual(['grep', 'read', 'skill', 'write']);
    expect(binding.effectiveSkills).toMatchObject([{
      name: 'office-reports',
      source: 'user',
    }]);
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Create a report.' },
    });

    const options = starts[0]?.options;
    expect(options?.provider).toBe('bound-provider');
    expect(options?.modelOverride).toBe('bound-model');
    expect(options?.effort).toBe('high');
    expect(options?.context?.agentProfile?.instructions).toBe('You are a general office agent.');
    expect(options?.context?.systemPromptOverride).toBeUndefined();
    expect(options?.context?.skillsPrompt).toContain('office-reports');
    expect(options?.context?.toolVisibilityPolicy?.({
      name: 'bash', sideEffect: 'mutates-shell', planModeAllowed: false,
    })).toBe(false);
    expect(options?.events?.beforeToolExecute).toBeTypeOf('function');
    await expect(options?.events?.beforeToolExecute?.('read', { path: 'report.md' }))
      .resolves.toBe(true);
    expect(() => options?.context?.assertReadablePath?.(path.join(workspace, 'credentials')))
      .toThrow(/secret-bearing/i);
  });

  it('blocks path escape and secret-bearing reads at call time', async () => {
    writeAgent({ tools: '[read]', skills: '[]' });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy({ workspace: 'read' }),
    });
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Read files.' },
    });
    const guardrail = starts[0]?.options?.guardrails?.[0] as ToolGuardrail;
    const agent = createAgent({ name: 'test', instructions: '' });

    await expect(guardrail.beforeTool?.({
      id: '1', name: 'read', input: { path: path.join(workspace, '..', 'outside.txt') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: '2', name: 'read', input: { path: path.join(workspace, '.env') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: '3', name: 'read', input: { path: path.join(workspace, 'report.txt') },
    }, { agent })).resolves.toEqual({ action: 'allow' });
  });

  it('blocks existing and not-yet-created paths that escape through a workspace link', async () => {
    const outside = path.join(home, 'outside');
    const linked = path.join(workspace, 'linked');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    writeAgent({ tools: '[read, write]', skills: '[]' });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Inspect and write files.' },
    });
    const guardrail = starts[0]?.options?.guardrails?.[0] as ToolGuardrail;
    const agent = createAgent({ name: 'test', instructions: '' });

    await expect(guardrail.beforeTool?.({
      id: 'linked-read', name: 'read', input: { path: path.join(linked, 'secret.txt') },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
    await expect(guardrail.beforeTool?.({
      id: 'linked-write', name: 'write', input: { path: path.join(linked, 'new.txt'), content: 'x' },
    }, { agent })).resolves.toMatchObject({ action: 'block' });
  });

  it('rejects non-native tools that lack an explicit remote contract', async () => {
    const unregister = registerTool({
      name: 'unsafe-office-tool',
      description: 'Unclassified tool',
      input_schema: { type: 'object', properties: {}, required: [] },
      sideEffect: 'mutates-state',
      toClassifierInput: () => '',
      handler: async () => 'ok',
    });
    try {
      writeAgent({ tools: '[unsafe-office-tool]', skills: '[]' });
      const service = createRuntimeAgentBindingService(host());
      const owner = await service.openOwnerSession();
      await expect(service.bindLocal({
        ownerSessionId: owner.ownerSessionId,
        ref: { source: 'markdown:user', name: 'office-agent' },
        workspace: { mode: 'fixed', root: workspace },
        toolPolicy: policy({ tools: ['unsafe-office-tool'] }),
      })).rejects.toThrow(/remote contract/i);
    } finally {
      unregister();
    }
  });

  it('admits exact Skill scripts through a run-scoped isolated broker', async () => {
    writeAgent({ tools: '[skill, run_skill_script]', skills: '[office-reports]' });
    writeSkill();
    const runner = { run: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined) };
    const testHost = host();
    const createSkillScriptRunner = vi.fn(async () => runner);
    const service = createRuntimeAgentBindingService({ ...testHost, createSkillScriptRunner });
    const owner = await service.openOwnerSession();
    const binding = await service.bindLocal({
      ownerSessionId: owner.ownerSessionId,
      ref: { source: 'markdown:user', name: 'office-agent' },
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy({
        process: 'isolated',
        skillScripts: { 'office-reports': ['scripts/render.mjs'] },
      }),
    });

    expect(binding.effectiveTools).toEqual(['run_skill_script', 'skill']);
    expect(createSkillScriptRunner).toHaveBeenCalledWith(expect.objectContaining({
      admissions: { 'office-reports': ['scripts/render.mjs'] },
    }));
    await service.startLocal({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedConfigurationRevision: binding.configurationRevision,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Render the report.' },
    });
    expect(starts[0]?.options?.context?.skillScriptRunner).toBe(runner);
    await service.closeOwnerSession(owner.ownerSessionId);
    expect(runner.dispose).toHaveBeenCalledOnce();
  });

  it('rejects malformed process and script authority for direct SDK callers', async () => {
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    await expect(service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'managed' },
      toolPolicy: policy({ skillScripts: { reports: ['scripts/render.py'] } }),
    })).rejects.toThrow(/enabled together/i);
  });
});

describe('FEATURE_269 Runtime host tool authorization', () => {
  async function bindHostTools(
    toolPolicy: RuntimeExecutionToolPolicy,
  ): Promise<{ readonly binding: RuntimeBoundDefaultAgent; readonly guardrail: ToolGuardrail }> {
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    const binding = await service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy,
    });
    await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'a2a-session',
      input: { type: 'text', text: 'Use materialized host tools.' },
    });
    return { binding, guardrail: starts[0]?.options?.guardrails?.[0] as ToolGuardrail };
  }

  it('admits host capability ids exactly as hostTools authorizes', async () => {
    const { binding, guardrail } = await bindHostTools(policy({ hostTools: ['host_search'] }));
    const agent = createAgent({ name: 'test', instructions: '' });

    expect(binding.effectiveTools).toContain('mcp_call');
    expect(binding.effectiveTools).toContain('mcp_describe');
    await expect(guardrail.beforeTool?.({
      id: '1', name: 'mcp_call', input: { id: 'host:lease-1:host_search', args: {} },
    }, { agent })).resolves.toEqual({ action: 'allow' });
    await expect(guardrail.beforeTool?.({
      id: '2', name: 'mcp_describe', input: { id: 'host:lease-2:host_search' },
    }, { agent })).resolves.toEqual({ action: 'allow' });
    await expect(guardrail.beforeTool?.({
      id: '3', name: 'mcp_search', input: { server: 'host' },
    }, { agent })).resolves.toEqual({ action: 'allow' });
  });

  it('rejects unauthorized host tools and non-tool capability kinds', async () => {
    const { guardrail } = await bindHostTools(policy({ hostTools: ['host_search'] }));
    const agent = createAgent({ name: 'test', instructions: '' });

    await expect(guardrail.beforeTool?.({
      id: '1', name: 'mcp_call', input: { id: 'host:lease-1:host_write', args: {} },
    }, { agent })).resolves.toMatchObject({ action: 'block', reason: expect.stringMatching(/not admitted by the remote policy/i) });
    await expect(guardrail.beforeTool?.({
      id: '2', name: 'mcp_call', input: { id: 'host:lease-1' },
    }, { agent })).resolves.toMatchObject({ action: 'block', reason: expect.stringMatching(/capability id is invalid/i) });
    await expect(guardrail.beforeTool?.({
      id: '3', name: 'mcp_read_resource', input: { id: 'host:lease-1:host_search' },
    }, { agent })).resolves.toMatchObject({ action: 'block', reason: expect.stringMatching(/capability id is invalid/i) });
  });

  it('keeps the host pseudo-server closed without hostTools', async () => {
    const { binding, guardrail } = await bindHostTools(policy({ mcp: { docs: ['list_files'] } }));
    const agent = createAgent({ name: 'test', instructions: '' });

    expect(binding.effectiveTools).toContain('mcp_search');
    await expect(guardrail.beforeTool?.({
      id: '1', name: 'mcp_search', input: { server: 'host' },
    }, { agent })).resolves.toMatchObject({ action: 'block', reason: expect.stringMatching(/explicitly admitted server/i) });
    await expect(guardrail.beforeTool?.({
      id: '2', name: 'mcp_call', input: { id: 'host:lease-1:list_files', args: {} },
    }, { agent })).resolves.toMatchObject({ action: 'block', reason: expect.stringMatching(/not admitted by the remote policy/i) });
  });

  it('rejects duplicate, wildcard, and malformed hostTools names', async () => {
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    await expect(service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'managed' },
      toolPolicy: policy({ hostTools: ['host_search', 'host_search'] }),
    })).rejects.toThrow(/duplicates/i);
    await expect(service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'managed' },
      toolPolicy: policy({ hostTools: ['*'] }),
    })).rejects.toThrow(/wildcards/i);
    await expect(service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'managed' },
      toolPolicy: policy({ hostTools: ['1host'] }),
    })).rejects.toThrow(/valid host tool names/i);
  });
});
