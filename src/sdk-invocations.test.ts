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

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't37-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T37_PROBE_KEY', model: 't37-probe', supportsThinking: false,
  };
  constructor(
    private readonly capture: (messages: readonly KodaXMessage[]) => void,
  ) { super(); }
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    this.capture(messages);
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

it('expands a queued Skill Host-side at actual consumption', async () => {
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
    await runtime.runs.acceptInput({
      sessionId: session.id, inputId: 'skill-turn',
      text: '/audit-helper focus on auth', delivery: 'after_turn',
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
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)))
      .join('\n');
    expect(userText).toContain('Audit request: focus on auth');
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
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
