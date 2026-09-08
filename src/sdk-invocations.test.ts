import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { FileSessionStorage } from '@kodax-ai/repl';
import * as coding from '@kodax-ai/coding';

/**
 * FEATURE_298 T37 S1 — the Host prepares Skills from a trusted registry:
 * expansion, metadata, and the enforce-at-runtime policy are minted
 * Host-side; the client only ever supplied a name and argument text.
 */
async function seedSkillProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-skill-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'audit-helper');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: audit-helper',
      'description: Audit the current diff with arguments',
      'allowed-tools: Read, Grep',
      'model: t37-skill-model',
      '---',
      '',
      'Audit request: $ARGUMENTS',
    ].join('\n'),
    'utf8',
  );
  const dynDir = path.join(projectRoot, '.kodax', 'skills', 'dyn-context');
  await mkdir(dynDir, { recursive: true });
  await writeFile(
    path.join(dynDir, 'SKILL.md'),
    [
      '---',
      'name: dyn-context',
      'description: Uses dynamic context blocks',
      '---',
      '',
      'Workspace root is !`pwd`.',
    ].join('\n'),
    'utf8',
  );
  return projectRoot;
}

it('prepares a Skill Host-side with expansion, metadata, and runtime policy', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'audit-helper',
      argumentsText: 'focus on auth',
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('focus on auth');
    expect(prepared.invocation.source).toBe('skill');
    expect(prepared.invocation.allowedTools ?? '').toContain('Read');
    expect(prepared.invocation.allowedTools ?? '').toContain('Grep');
    expect(prepared.invocation.skillInvocation?.name).toBe('audit-helper');
    expect(prepared.invocation.skillInvocation?.runtimePolicy?.enforceAtRuntime).toBe(true);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('reports unknown skills without touching any executor', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'definitely-not-a-skill',
      argumentsText: '',
    });
    expect(prepared).toMatchObject({ kind: 'unknown' });
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('hard-disables `!`cmd`` dynamic context when no host executor is bound', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'dyn-context',
      argumentsText: '',
    });
    // The kill switch surfaces as an inlined placeholder (the resolver never
    // poisons a whole load); no shell command may have run.
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('Dynamic context disabled by host');
    expect(prepared.invocation.prompt).not.toMatch(/Workspace root is [A-Za-z]:\\/);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it.each(['session', 'profile', 'legacy-session'] as const)('executes read-only dynamic context under the admitted %s policy', async (policy) => {
  const projectRoot = await seedSkillProject();
  const file = path.join(projectRoot, '.kodax', 'skills', 'dyn-context', 'SKILL.md');
  await writeFile(file, '---\nname: dyn-context\ndescription: context test\n---\nValue !`echo dynamic-context-ok`\nDenied !`echo unsafe > forbidden.txt`\n');
  if (policy === 'profile') await writeFile(path.join(projectRoot, '.kodax', 'config.json'), JSON.stringify({ permissionMode: 'full-access' }));
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const session = policy === 'legacy-session' ? { id: 'legacy-skill-session' }
      : await runtime.sessions.create({ projectPath: projectRoot });
    if (policy === 'legacy-session') await new FileSessionStorage({ sessionsDir: path.join(projectRoot, '.kodax', 'sessions') })
      .save(session.id, { messages: [], title: 'Legacy Skill', gitRoot: '' });
    if (policy !== 'profile') await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: projectRoot });
    const prepared = await runtime.invocations.prepareSkill({ projectRoot, name: 'dyn-context', sessionId: session.id });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Expected trusted Skill preparation');
    expect(prepared.invocation.prompt).toContain('Value dynamic-context-ok');
    expect(prepared.invocation.prompt).not.toContain('Dynamic context disabled');
    expect(prepared.invocation.prompt).toContain('read-only');
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('rejects Skill preparation and product input for a legacy Session with no workspace identity', async () => {
  const projectRoot = await seedSkillProject();
  const hostCwd = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
  const capture = vi.fn();
  registerModelProvider('t37-probe', () => new ProbeProvider(capture));
  vi.stubEnv('KODAX_T37_PROBE_KEY', 'test-key');
  const shell = vi.spyOn(coding, 'toolBash').mockResolvedValue('Command: pwd\nExit: 0\nUNADMITTED-CONTEXT');
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 't37-probe' });
  try {
    const sessionId = 'legacy-no-workspace';
    await new FileSessionStorage({ sessionsDir: path.join(projectRoot, '.kodax', 'sessions') })
      .save(sessionId, { messages: [], title: 'No workspace', gitRoot: '' });
    await runtime.sessions.updateSettings(sessionId, { permissionMode: 'full-access' });
    await expect(runtime.invocations.prepareSkill({ projectRoot, name: 'dyn-context', sessionId }))
      .rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(runtime.runs.acceptInput({ sessionId, inputId: 'unadmitted-skill', text: '/skill:dyn-context inspect' }))
      .rejects.toMatchObject({ code: 'session_not_admitted' });
    expect(shell).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  } finally {
    shell.mockRestore();
    hostCwd.mockRestore();
    await runtime.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it('expands dynamic context through the trusted Host preparation executor', async () => {
  const projectRoot = await seedSkillProject();
  const { createRuntimeInvocationService } = await import('./runtime-invocations.js');
  const { createRuntimeReviewPreparationService } = await import('./runtime-review-preparation.js');
  const execute = vi.fn(async () => 'HOST-CONTROLLED-OUTPUT');
  const resolveSkillContext = vi.fn(async () => ({
    workingDirectory: projectRoot, projectRoot, executeDynamicContext: execute,
  }));
  const service = createRuntimeInvocationService({
    reviewPreparation: createRuntimeReviewPreparationService(), resolveSkillContext,
  });
  try {
    const prepared = await service.prepareSkill({ projectRoot, sessionId: 'skill-session', name: 'dyn-context' });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('Workspace root is HOST-CONTROLLED-OUTPUT.');
    expect(resolveSkillContext).toHaveBeenCalledWith({ projectRoot, sessionId: 'skill-session', name: 'dyn-context' });
    expect(execute).toHaveBeenCalledWith('pwd', projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it.each(['disabled', 'missing-executor'] as const)('keeps dynamic context closed when the Host context is %s', async (policy) => {
  const projectRoot = await seedSkillProject();
  const { createRuntimeInvocationService } = await import('./runtime-invocations.js');
  const { createRuntimeReviewPreparationService } = await import('./runtime-review-preparation.js');
  const execute = vi.fn(async () => 'must not run');
  const service = createRuntimeInvocationService({
    reviewPreparation: createRuntimeReviewPreparationService(),
    resolveSkillContext: async () => ({
      workingDirectory: projectRoot,
      ...(policy === 'disabled' ? { disableDynamicContext: true, executeDynamicContext: execute } : {}),
    }),
  });
  try {
    const prepared = await service.prepareSkill({ projectRoot, name: 'dyn-context' });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('Dynamic context disabled by host');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't37-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T37_PROBE_KEY', model: 't37-probe', supportsThinking: false,
  };
  constructor(
    private readonly capture: (messages: readonly KodaXMessage[]) => void,
  ) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    const messages = args[0];
    if (args[1].some(tool => tool.name === 'emit_sidecar_verdict')) return {
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: 'verdict', name: 'emit_sidecar_verdict', input: { verdict: 'accept' } }],
    };
    this.capture([{ role: 'system', content: args[2] }, ...messages]);
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

it.each(['immediate', 'after_turn'] as const)('expands a %s Skill Host-side at actual consumption', async (delivery) => {
  const projectRoot = await seedSkillProject();
  const captured: KodaXMessage[][] = [];
  registerModelProvider('t37-probe', () => new ProbeProvider((messages) => {
    captured.push(messages.map((message) => ({ ...message })));
  }));
  vi.stubEnv('KODAX_T37_PROBE_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 't37-probe',
  });
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, {
      agentMode: 'sa', permissionMode: 'full-access',
    });
    // The first input keeps the session busy; the Skill input must wait in
    // the queue and only expand when the queue drains.
    const active = await runtime.runs.acceptInput({
      sessionId: session.id, inputId: 'initial', text: 'Start.',
    });
    if (delivery === 'immediate') await runtime.runs.await(active.runId!);
    await runtime.runs.acceptInput({
      sessionId: session.id, inputId: 'skill-turn',
      text: '/audit-helper focus on auth', delivery,
    });
    if ('runId' in active && active.runId !== undefined) {
      await runtime.runs.await(active.runId);
    }
    await expect.poll(async () => {
      const runs = await runtime.runs.list({ sessionId: session.id });
      return runs.filter((run) => run.phase === 'completed' || run.phase === 'failed').length;
    }, { timeout: 20_000 }).toBe(2);

    // The learning reviewer shares this provider; assert on content, not order.
    const userText = captured.flat()
      .map((message) => (typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)))
      .join('\n');
    expect(userText).toContain('Audit request: focus on auth');
    const acceptedSkill = await runtime.runs.getInput(session.id, 'skill-turn');
    expect((await runtime.runs.get(acceptedSkill!.runId!)).model).toBe('t37-skill-model');
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

it.each(['sa', 'ama'] as const)('isolates a fork Skill in %s and keeps parent conversation intact', async agentMode => {
  const projectRoot = await seedSkillProject();
  await writeFile(path.join(projectRoot, '.kodax', 'skills', 'audit-helper', 'SKILL.md'),
    '---\nname: audit-helper\ndescription: isolated audit\ncontext: fork\n---\nFORK-REQUEST $ARGUMENTS\n');
  const captured: KodaXMessage[][] = [];
  registerModelProvider('t37-probe', () => new ProbeProvider(messages => captured.push(structuredClone([...messages]))));
  vi.stubEnv('KODAX_T37_PROBE_KEY', 'test-key');
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 't37-probe' });
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
    const first = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'parent', text: 'PARENT-PRIVATE-CONTEXT' });
    await runtime.runs.await(first.runId!);
    await runtime.sessions.updateSettings(session.id, { agentMode });
    captured.length = 0;
    const fork = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'fork', text: '/audit-helper fresh context' });
    const completed = await runtime.runs.await(fork.runId!);
    expect(completed.phase, completed.error?.message).toBe('completed');
    expect(completed.result?.contextTokenSnapshot).toBeUndefined();
    const invocation = captured.filter(messages => messages.some(message =>
      JSON.stringify(message.content).includes('FORK-REQUEST')));
    expect(invocation.length).toBeGreaterThan(0);
    expect(JSON.stringify(invocation)).not.toContain('PARENT-PRIVATE-CONTEXT');
    const transcript = await runtime.sessions.transcript(session.id);
    expect(JSON.stringify(transcript)).toContain('PARENT-PRIVATE-CONTEXT');
    expect(transcript?.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(transcript?.messages).toEqual(completed.result?.messages);
    expect(JSON.stringify(transcript?.messages)).not.toContain('FORK-REQUEST');
  } finally {
    await runtime.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

it.each(['sa', 'ama'] as const)('keeps a fork Skill settlement unknown in %s when its parent result cannot be saved', async agentMode => {
  const projectRoot = await seedSkillProject();
  await writeFile(path.join(projectRoot, '.kodax', 'skills', 'audit-helper', 'SKILL.md'),
    '---\nname: audit-helper\ndescription: isolated audit\ncontext: fork\n---\nFORK-REQUEST $ARGUMENTS\n');
  registerModelProvider('t37-probe', () => new ProbeProvider(() => undefined));
  vi.stubEnv('KODAX_T37_PROBE_KEY', 'test-key');
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 't37-probe' });
  const save = FileSessionStorage.prototype.save;
  const saveSpy = vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(async function (this: FileSessionStorage, id, data) {
    if (data.messages.at(-1)?.role === 'assistant'
      && data.messages.some(message => message.content === '/audit-helper fresh context')) {
      throw Object.assign(new Error('fork parent result write failed'), { code: 'EIO' });
    }
    return save.call(this, id, data);
  });
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, { agentMode, permissionMode: 'full-access' });
    const fork = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'fork', text: '/audit-helper fresh context' });
    const completed = await runtime.runs.await(fork.runId!);
    expect(completed).toMatchObject({ phase: 'unknown', error: { code: 'run_settlement_not_persisted' } });
    expect(await runtime.runs.get(fork.runId!)).toMatchObject({ phase: 'unknown' });
  } finally {
    saveSpy.mockRestore();
    await runtime.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

async function seedGitRepo(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-review-'));
  const git = (args: string[]) => run('git', args, { cwd: projectRoot, windowsHide: true });
  await git(['init', '-q']);
  await git(['config', 'user.email', 't37@test.local']);
  await git(['config', 'user.name', 't37']);
  await writeFile(path.join(projectRoot, 'a.txt'), 'one\n', 'utf8');
  await git(['add', 'a.txt']);
  await git(['commit', '-qm', 'base']);
  await writeFile(path.join(projectRoot, 'a.txt'), 'one\ntwo\n', 'utf8');
  return projectRoot;
}

it('prepares /review Host-side: diff capture, workflow pieces, empty, and error', async () => {
  const projectRoot = await seedGitRepo();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    await runtime.sessions.create({ sessionId: 'session-t37', projectPath: projectRoot });
    const prepared = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: [],
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.source).toBe('prompt');
    expect(prepared.invocation.displayName).toBe('/review');
    expect(prepared.invocation.prompt).toContain('uncommitted changes');
    expect(prepared.invocation.prompt).toContain('+two');

    const lean = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: ['--lean'],
    });
    expect(lean.kind).toBe('prepared');
    if (lean.kind === 'prepared') {
      expect(lean.invocation.displayName).toBe('/review --lean');
      expect(lean.invocation.prompt.toLowerCase()).toContain('lean');
    }

    const workflow = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: ['--workflow', '--lean'],
    });
    expect(workflow.kind).toBe('workflow');
    if (workflow.kind !== 'workflow') return;
    expect(workflow.workflow.builtinName).toBe('scoped-review');
    expect(workflow.workflow.displayName).toBe('/review --workflow --lean');
    expect(workflow.workflow.request).toContain('scoped-review');
    const args = workflow.workflow.builtinArgs as { packets?: unknown[]; lean?: boolean };
    expect(Array.isArray(args.packets)).toBe(true);
    expect(args.lean).toBe(true);

    const badScope = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: ['sha'],
    });
    expect(badScope).toMatchObject({ kind: 'error' });

    // Option-shaped sha tokens never reach git argv.
    const optionShaped = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: ['sha', '--help'],
    });
    expect(optionShaped).toMatchObject({ kind: 'error', message: expect.stringContaining('invalid commit hash') });

    // /agents lean: present file prepares; missing file reports missing.
    const leanPresent = await runtime.invocations.prepareAgentsLean({ projectRoot });
    expect(leanPresent.kind).toBe('missing');
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
    const leanPrepared = await runtime.invocations.prepareAgentsLean({ projectRoot });
    expect(leanPrepared.kind).toBe('prepared');
    if (leanPrepared.kind !== 'prepared') return;
    expect(leanPrepared.invocation.displayName).toBe('/agents lean');
    expect(leanPrepared.invocation.prompt).toContain('AGENTS.md');
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

it('reports an empty review for a clean tree', async () => {
  const projectRoot = await seedGitRepo();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['checkout', '--', 'a.txt'], { cwd: projectRoot, windowsHide: true });
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    await runtime.sessions.create({ sessionId: 'session-t37', projectPath: projectRoot });
    const prepared = await runtime.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37', args: [],
    });
    expect(prepared).toMatchObject({ kind: 'empty' });
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);

it('prepares discovered prompt commands Host-side with frontmatter metadata', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-cmd-'));
  const cmdDir = path.join(projectRoot, '.kodax', 'commands');
  await mkdir(cmdDir, { recursive: true });
  await writeFile(
    path.join(cmdDir, 'deploy-check.md'),
    [
      '---',
      'description: Verify the deploy checklist',
      'allowed-tools: Read, Bash',
      'context: fork',
      'argument-hint: [env]',
      '---',
      '',
      'Run the deploy checklist for $ARGUMENTS.',
    ].join('\n'),
    'utf8',
  );
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareCommand({
      projectRoot,
      name: 'deploy-check',
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.source).toBe('prompt');
    expect(prepared.invocation.prompt).toContain('deploy checklist');
    expect(prepared.invocation.allowedTools ?? '').toContain('Read');
    expect(prepared.invocation.context).toBe('fork');

    // Registry-known builtin commands stay client-side.
    const local = await runtime.invocations.prepareCommand({
      projectRoot,
      name: 'help',
    });
    expect(local.kind).toBe('local');

    const unknown = await runtime.invocations.prepareCommand({
      projectRoot,
      name: 'definitely-not-a-command',
    });
    expect(unknown.kind).toBe('unknown');
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
