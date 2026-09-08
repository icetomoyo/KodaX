import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LearnedAreaStore,
  commitLearnedSkillRevision,
  createAgent,
  createLearnedCapabilityScope,
  listLearnedSkillUsageReceipts,
  resolveProjectLearnedAreaRoot,
  type ToolGuardrail,
} from '@kodax-ai/agent';
import { canonicalMemoryProjectId, registerTool } from '@kodax-ai/coding';
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
    expect(options?.context?.systemPromptOverride).toBe('You are a general office agent.');
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

describe('FEATURE_263 Runtime learned Skill binding', () => {
  it('releases a canary admitted in one physical root when the fallback root fails', async () => {
    execFileSync('git', ['init'], { cwd: workspace, windowsHide: true, stdio: 'ignore' });
    const remoteUrl = 'https://github.com/kodax/partial-root.git';
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: workspace,
      windowsHide: true,
      stdio: 'ignore',
    });
    const configHome = path.join(home, '.kodax');
    const tenantId = `local:${configHome}`;
    const remoteProjectId = canonicalMemoryProjectId(remoteUrl);
    const localProjectId = `local:${path.resolve(workspace).toLowerCase()}`;
    const remoteStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: remoteProjectId,
    }));
    const localStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: localProjectId,
    }));
    await Promise.all([remoteStore.initialize(), localStore.initialize()]);
    const record = await commitLearnedSkillRevision(remoteStore, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId: remoteProjectId }),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-runtime-partial',
        inputHash: 'e'.repeat(64),
        decisionId: 'decision-runtime-partial',
        actionId: 'action-runtime-partial',
      },
    });
    const originalList = LearnedAreaStore.prototype.listCapabilities;
    const list = vi.spyOn(LearnedAreaStore.prototype, 'listCapabilities')
      .mockImplementation(async function (this: LearnedAreaStore) {
        if (this.paths.root === localStore.paths.root) throw new Error('fallback root unavailable');
        return originalList.call(this);
      });
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();
    try {
      const binding = await service.bindDefault({
        ownerSessionId: owner.ownerSessionId,
        workspace: { mode: 'fixed', root: workspace },
        toolPolicy: policy(),
      });
      expect(binding.effectiveSkills).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'verify-release', source: 'learned' }),
      ]));
    } finally {
      list.mockRestore();
      await service.closeOwnerSession(owner.ownerSessionId);
    }
    expect((await readCanary(remoteStore, record.capabilityId)))
      .not.toHaveProperty('binding');
  });

  it('binds and completes a local-root canary after a git remote becomes available', async () => {
    execFileSync('git', ['init'], { cwd: workspace, windowsHide: true, stdio: 'ignore' });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/kodax/dual-root.git'],
      { cwd: workspace, windowsHide: true, stdio: 'ignore' },
    );
    const configHome = path.join(home, '.kodax');
    const tenantId = `local:${configHome}`;
    const localProjectId = `local:${path.resolve(workspace).toLowerCase()}`;
    const localStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: localProjectId,
    }));
    await localStore.initialize();
    const record = await commitLearnedSkillRevision(localStore, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId: localProjectId }),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-runtime-dual-root',
        inputHash: 'f'.repeat(64),
        decisionId: 'decision-runtime-dual-root',
        actionId: 'action-runtime-dual-root',
      },
    });
    const remoteStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: canonicalMemoryProjectId('https://github.com/kodax/dual-root.git'),
    }));
    await remoteStore.initialize();
    await remoteStore.writeCapability(record);
    let finishRun!: (result: RuntimeRunResult) => void;
    const runResult = new Promise<RuntimeRunResult>((resolve) => { finishRun = resolve; });
    const service = createRuntimeAgentBindingService({
      ...host(),
      runs: {
        async start(input) {
          starts.push(input);
          return { runId: 'run-dual-root', sessionId: input.sessionId, result: runResult };
        },
      },
    });
    const owner = await service.openOwnerSession();
    const binding = await service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });
    expect(binding.effectiveSkills).toContainEqual(expect.objectContaining({
      name: 'verify-release',
      source: 'learned',
    }));

    const run = await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'session-dual-root',
      input: { type: 'text', text: 'Verify the release.' },
    });
    const context = starts[0]?.options?.context;
    await expect(context?.admitLearnedSkillInvocation?.({
      sessionId: 'session-dual-root',
      capabilityId: record.capabilityId,
      revision: record.artifact.contentRevision,
      fingerprint: record.artifact.fingerprint,
    })).resolves.toMatchObject({ invocationId: expect.any(String) });
    await context?.completeLearnedSkillOutcomes?.({
      sessionId: 'session-dual-root',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:runtime-dual-root'],
    });
    await expect(localStore.readCapability(record.capabilityId)).resolves.toMatchObject({
      canary: { verifiedSuccesses: 1 },
    });
    await expect(remoteStore.readCapability(record.capabilityId)).resolves.toMatchObject({
      lifecycle: 'testing',
      canary: { verifiedSuccesses: 0 },
    });
    finishRun({ runId: run.runId, sessionId: run.sessionId, phase: 'completed' });
    await run.result;
    await service.closeOwnerSession(owner.ownerSessionId);
  });

  it('gives each root run a distinct canary reservation and excludes a concurrent root', async () => {
    const configHome = path.join(home, '.kodax');
    const tenantId = `local:${configHome}`;
    const projectId = `local:${path.resolve(workspace).toLowerCase()}`;
    const rootDir = resolveProjectLearnedAreaRoot(configHome, { tenantId, projectId });
    const store = new LearnedAreaStore(rootDir);
    await store.initialize();
    const record = await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId }),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-concurrent',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-concurrent',
        actionId: 'action-concurrent',
      },
    });
    let resolveFirst!: (result: RuntimeRunResult) => void;
    const firstResult = new Promise<RuntimeRunResult>((resolve) => {
      resolveFirst = resolve;
    });
    let startCount = 0;
    const testHost: RuntimeAgentBindingHost = {
      ...host(),
      runs: {
        async start(input) {
          startCount += 1;
          starts.push(input);
          const runId = `run-${startCount}`;
          return {
            runId,
            sessionId: input.sessionId,
            result: startCount === 1
              ? firstResult
              : Promise.resolve({ runId, sessionId: input.sessionId, phase: 'completed' }),
          };
        },
      },
    };
    const service = createRuntimeAgentBindingService(testHost);
    const owner = await service.openOwnerSession();
    const binding = await service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });

    expect((await readCanary(store, record.capabilityId))).not.toHaveProperty('binding');
    const first = await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'root-a',
      input: { type: 'text', text: 'First root.' },
    });
    const firstBinding = (await readCanary(store, record.capabilityId)).binding?.bindingId;
    expect(firstBinding).toBeTypeOf('string');
    expect(firstBinding).not.toBe(binding.bindingId);
    expect(starts[0]?.options?.context?.skillRegistry?.has('verify-release')).toBe(true);

    await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'root-b',
      input: { type: 'text', text: 'Concurrent root.' },
    });
    expect(starts[1]?.options?.context?.skillRegistry?.has('verify-release')).toBe(false);
    expect((await readCanary(store, record.capabilityId)).binding?.bindingId)
      .toBe(firstBinding);

    resolveFirst({ runId: first.runId, sessionId: first.sessionId, phase: 'completed' });
    await first.result;
    expect((await readCanary(store, record.capabilityId))).not.toHaveProperty('binding');

    await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'root-c',
      input: { type: 'text', text: 'Next root.' },
    });
    const nextBinding = (await readCanary(store, record.capabilityId)).binding?.bindingId;
    expect(nextBinding).toBeTypeOf('string');
    expect(nextBinding).not.toBe(firstBinding);
    expect(starts[2]?.options?.context?.skillRegistry?.has('verify-release')).toBe(true);
    await service.closeOwnerSession(owner.ownerSessionId);
  });

  it('keeps Runtime binding available when the project Learned Area is invalid', async () => {
    const configHome = path.join(home, '.kodax');
    const tenantId = `local:${configHome}`;
    const projectId = `local:${path.resolve(workspace).toLowerCase()}`;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId,
    }));
    await store.initialize();
    writeFileSync(path.join(store.paths.capabilities, 'broken.json'), '{not-json');
    const service = createRuntimeAgentBindingService(host());
    const owner = await service.openOwnerSession();

    const binding = await service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });
    expect(binding.effectiveSkills).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'learned' }),
    ]));
    await service.closeOwnerSession(owner.ownerSessionId);
  });

  it('admits a project canary, records exact invocation, and correlates verified outcome', async () => {
    const configHome = path.join(home, '.kodax');
    const tenantId = `local:${configHome}`;
    const projectId = `local:${path.resolve(workspace).toLowerCase()}`;
    const rootDir = resolveProjectLearnedAreaRoot(configHome, { tenantId, projectId });
    const store = new LearnedAreaStore(rootDir);
    await store.initialize();
    const record = await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId }),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    let finishRun!: (result: RuntimeRunResult) => void;
    const runResult = new Promise<RuntimeRunResult>((resolve) => { finishRun = resolve; });
    const service = createRuntimeAgentBindingService({
      ...host(),
      runs: {
        async start(input) {
          starts.push(input);
          return {
            runId: 'run-learned',
            sessionId: input.sessionId,
            result: runResult,
          };
        },
      },
    });
    const owner = await service.openOwnerSession();
    const binding = await service.bindDefault({
      ownerSessionId: owner.ownerSessionId,
      workspace: { mode: 'fixed', root: workspace },
      toolPolicy: policy(),
    });

    expect(binding.effectiveSkills).toContainEqual(expect.objectContaining({
      name: 'verify-release',
      source: 'learned',
    }));
    const run = await service.startDefault({
      ownerSessionId: owner.ownerSessionId,
      bindingId: binding.bindingId,
      expectedExecutionPolicyRevision: binding.executionPolicyRevision,
      sessionId: 'session-learned',
      input: { type: 'text', text: 'Verify the release.' },
    });
    const context = starts[0]?.options?.context;
    expect(context?.configHome).toBe(configHome);
    expect(context?.learnedSkillBindingId).toMatch(/^root_/);
    const invocation = await context?.admitLearnedSkillInvocation?.({
      sessionId: 'session-learned',
      capabilityId: record.capabilityId,
      revision: record.artifact.contentRevision,
      fingerprint: record.artifact.fingerprint,
    });
    expect(invocation?.invocationId).toBeTypeOf('string');
    await context?.completeLearnedSkillOutcomes?.({
      sessionId: 'session-learned',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-1'],
    });

    expect(await store.readCapability(record.capabilityId)).toMatchObject({
      lifecycle: 'testing',
      canary: { verifiedSuccesses: 1 },
    });
    expect(await listLearnedSkillUsageReceipts(store, 'session-learned'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'offered' }),
        expect.objectContaining({ kind: 'invoked' }),
        expect.objectContaining({ kind: 'outcome', outcome: 'verified_success' }),
      ]));
    finishRun({ runId: run.runId, sessionId: run.sessionId, phase: 'completed' });
    await run.result;
    await service.closeOwnerSession(owner.ownerSessionId);
  });
});

async function readCanary(store: LearnedAreaStore, capabilityId: string) {
  const record = await store.readCapability(capabilityId);
  if (record?.schemaVersion !== 2) throw new Error('Expected a v2 capability record.');
  return record.canary;
}
