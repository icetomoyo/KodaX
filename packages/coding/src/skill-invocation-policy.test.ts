import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';
import { awaitRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';
import {
  setKodaXDiagnosticSink,
  SkillRegistry,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import type { KodaXOptions } from './types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function nodeCommand(source: string): string {
  return `"${process.execPath}" -e "${source}"`;
}

async function optionsWithSkill(input: {
  readonly allowedTools?: string;
  readonly preToolUse?: string;
  readonly postToolUse?: string;
  readonly model?: string;
  readonly sessionStart?: string;
  readonly userPromptSubmit?: string;
  readonly stop?: string;
  readonly fork?: boolean;
  readonly notification?: string;
}): Promise<{ readonly root: string; readonly options: KodaXOptions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-policy-'));
  tempDirs.push(root);
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const skillDir = path.join(root, '.kodax', 'skills', 'transport-skill');
  await mkdir(skillDir, { recursive: true });
  const hookLines = input.preToolUse || input.postToolUse || input.sessionStart || input.userPromptSubmit || input.stop || input.notification
    ? [
        'hooks:',
        ...(input.notification
          ? ['  Notification:', `    - command: ${JSON.stringify(input.notification)}`]
          : []),
        ...(input.stop
          ? [`  ${input.fork ? 'SubagentStop' : 'Stop'}:`, `    - command: ${JSON.stringify(input.stop)}`]
          : []),
        ...(input.sessionStart
          ? ['  SessionStart:', `    - command: ${JSON.stringify(input.sessionStart)}`]
          : []),
        ...(input.userPromptSubmit
          ? ['  UserPromptSubmit:', `    - command: ${JSON.stringify(input.userPromptSubmit)}`]
          : []),
        ...(input.preToolUse
          ? ['  PreToolUse:', '    - matcher: read', `      command: ${JSON.stringify(input.preToolUse)}`]
          : []),
        ...(input.postToolUse
          ? ['  PostToolUse:', '    - matcher: read', `      command: ${JSON.stringify(input.postToolUse)}`]
          : []),
      ]
    : [];
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: transport-skill',
    'description: Transport policy test',
    ...(input.allowedTools ? [`allowed-tools: ${JSON.stringify(input.allowedTools)}`] : []),
    ...(input.model ? [`model: ${input.model}`] : []),
    ...(input.fork ? ['context: fork'] : []),
    ...hookLines,
    '---',
    '',
    'Test.',
  ].join('\n'), 'utf8');
  return {
    root,
    options: {
      provider: 'mock-provider',
      events: { beforeToolExecute: async () => true },
      context: {
        gitRoot: root,
        executionCwd: root,
        skillInvocation: {
          name: 'transport-skill',
          path: path.join(skillDir, 'SKILL.md'),
          expandedContent: '<skill name="transport-skill">test</skill>',
          runtimePolicy: { enforceAtRuntime: true },
        },
      },
    },
  };
}

describe('applyRuntimeSkillInvocationPolicy', () => {
  it.each([undefined, 'Bash', '*'] as const)('retains Host authorization for unrestricted shell rules (%s)', async allowedTools => {
    const fixture = await optionsWithSkill({ allowedTools });
    fixture.options.events = { beforeToolExecute: async () => '[Blocked] Host decision' };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    expect(await options.events?.beforeToolExecute?.('bash', { command: 'echo one && echo two' }))
      .toBe('[Blocked] Host decision');
  });

  it.each(['cmd', undefined] as const)('rejects cmd expansion and single-quote command chains (%s)', async kind => {
    if (kind === undefined && process.platform !== 'win32') return;
    const fixture = await optionsWithSkill({ allowedTools: 'Bash(echo SAFE *)' });
    if (kind) fixture.options.context!.shellExecution = { version: 1, shell: { kind } };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    for (const command of ["echo SAFE 'x&echo SECOND&rem '", 'echo SAFE %KODAX_SKILL_PROBE%',
      'echo SAFE !KODAX_SKILL_PROBE!', 'echo SAFE ^&echo SECOND']) {
      expect(await options.events?.beforeToolExecute?.('bash', { command }), command).toContain('not allowed');
    }
    expect(await options.events?.beforeToolExecute?.('bash', { command: 'echo SAFE "x&y"' })).toBe(true);
  });

  it.each(['powershell', 'pwsh'] as const)('uses %s quoting for constrained commands', async kind => {
    const fixture = await optionsWithSkill({ allowedTools: 'Bash(echo SAFE *)' });
    fixture.options.context!.shellExecution = { version: 1, shell: { kind } };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    for (const command of ['echo SAFE \\;echo SECOND', 'echo SAFE \\|echo SECOND',
      'echo SAFE "x\\"; echo SECOND; #"']) {
      expect(await options.events?.beforeToolExecute?.('bash', { command }), command).toContain('not allowed');
    }
    for (const command of ['echo SAFE "x;y"', "echo SAFE 'x&y'", 'echo SAFE C:\\Work\\file.txt']) {
      expect(await options.events?.beforeToolExecute?.('bash', { command }), command).toBe(true);
    }
  });

  it('keeps constrained shell patterns from authorizing compound shell effects', async () => {
    const fixture = await optionsWithSkill({ allowedTools: 'Bash(git diff *)' });
    const hostAdmission = vi.fn(async () => true);
    fixture.options.events = { beforeToolExecute: hostAdmission };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    for (const command of [
      'git diff --stat && git commit -am x', 'git diff --stat & whoami',
      'git diff --stat || whoami', 'git diff --stat; whoami',
      'git diff --stat\nwhoami', 'git diff --stat\r\nwhoami',
      'git diff --stat | sh', 'git diff --stat > changed.txt',
      'git diff $(whoami)', 'git diff `whoami`',
    ]) {
      expect(await options.events?.beforeToolExecute?.('bash', { command }), command)
        .toContain('not allowed');
    }
    expect(hostAdmission).not.toHaveBeenCalled();
    for (const command of ['git diff --stat', 'git diff -- "file with spaces.ts"', 'git diff -- "a&&b.ts"']) {
      expect(await options.events?.beforeToolExecute?.('bash', { command })).toBe(true);
    }
    expect(hostAdmission).toHaveBeenCalledTimes(3);
  });

  it('reports an unregistered Skill as a local loading failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-unregistered-'));
    tempDirs.push(root);
    await expect(applyRuntimeSkillInvocationPolicy({
      provider: 'mock-provider',
      context: {
        gitRoot: root,
        skillRegistry: new SkillRegistry(root),
        skillInvocation: { name: 'draft-response', runtimePolicy: { enforceAtRuntime: true } },
      },
    })).rejects.toMatchObject({
      code: 'skill_not_registered', source: 'local', stage: 'skill_load', skillName: 'draft-response',
    });
  });

  it('reports a Skill absent from trusted discovery without echoing its supplied path', async () => {
    const { options, root } = await optionsWithSkill({});
    options.context!.skillInvocation = { name: 'kodax-missing-skill', path: path.join(root, 'private', 'SKILL.md'),
      runtimePolicy: { enforceAtRuntime: true } };
    await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
      code: 'skill_not_found', source: 'local', stage: 'skill_load', skillName: 'kodax-missing-skill',
      message: expect.not.stringContaining(root),
    });
  });

  it.each(['discover', 'loadFull'] as const)('keeps a %s failure local without exposing filesystem errors', async method => {
    const { options, root } = await optionsWithSkill({});
    const failing = vi.spyOn(SkillRegistry.prototype, method).mockRejectedValue(new Error(`EACCES ${root}/private/credentials`));
    try {
      await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
        code: method === 'discover' ? 'skill_registry_unavailable' : 'skill_policy_restore_failed',
        source: 'local', stage: method === 'discover' ? 'skill_load' : 'skill_policy', skillName: 'transport-skill',
        message: expect.not.stringContaining(root),
      });
    } finally { failing.mockRestore(); }
  });

  it('classifies a broken bound registry without using its supplied path', async () => {
    const { options, root } = await optionsWithSkill({});
    options.context!.skillRegistry = new SkillRegistry(root);
    const failing = vi.spyOn(options.context!.skillRegistry, 'has').mockImplementation(() => {
      throw new Error(`Registry unavailable at ${root}`);
    });
    try {
      await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
        code: 'skill_registry_unavailable', source: 'local', stage: 'skill_load',
        skillName: 'transport-skill', message: expect.not.stringContaining(root),
      });
    } finally { failing.mockRestore(); }
  });

  it('does not claim a Skill is missing when a real trusted source cannot be scanned', async () => {
    const { options, root } = await optionsWithSkill({});
    const source = path.join(root, 'private-skill-source');
    await writeFile(source, 'This configured source is a file, not a directory.');
    const registry = new SkillRegistry(root, { projectPaths: [source], userPaths: [], pluginPaths: [],
      builtinPath: path.join(root, 'absent-builtins') });
    await registry.discover();
    options.context!.skillRegistry = registry;
    await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
      code: 'skill_registry_unavailable', source: 'local', stage: 'skill_load',
      message: expect.not.stringContaining(root),
    });
  });

  it('reports real policy reload failure after trusted metadata was discovered', async () => {
    const { options, root } = await optionsWithSkill({});
    const registry = new SkillRegistry(root);
    await registry.discover();
    options.context!.skillRegistry = registry;
    await writeFile(path.join(root, '.kodax', 'skills', 'transport-skill', 'SKILL.md'), 'Invalid replacement policy');
    await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
      code: 'skill_policy_restore_failed', source: 'local', stage: 'skill_policy',
      skillName: 'transport-skill', message: expect.not.stringContaining(root),
    });
  });

  it('does not display a path-shaped Skill identifier', async () => {
    const { options, root } = await optionsWithSkill({});
    options.context!.skillRegistry = new SkillRegistry(root);
    options.context!.skillInvocation!.name = 'C:\\private\\skill-key';
    await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toMatchObject({
      code: 'skill_not_registered', skillName: 'unknown', message: expect.not.stringContaining('private'),
    });
  });

  it.each(['discover', 'loadFull'] as const)('preserves explicit abort during %s', async method => {
    const { options } = await optionsWithSkill({});
    const aborted = Object.assign(new Error('Stopped'), { name: 'AbortError' });
    const failing = vi.spyOn(SkillRegistry.prototype, method).mockRejectedValue(aborted);
    try { await expect(applyRuntimeSkillInvocationPolicy(options)).rejects.toBe(aborted); }
    finally { failing.mockRestore(); }
  });

  it('does not rewrite settled invocation results when a terminal observer throws', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    try {
      const policy = await applyRuntimeSkillInvocationPolicy({ provider: 'mock-provider',
        context: { commandInvocation: { name: 'registered', source: 'prompt', runtimePolicy: { enforceAtRuntime: true } } },
        events: { onComplete: () => { throw new Error('observer failed'); } },
      });
      policy.events?.onComplete?.();
      await expect(awaitRuntimeSkillInvocationPolicy(policy)).resolves.toBeUndefined();
      expect(diagnostics).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('terminal observer') }));
    } finally { restore(); }
  });
  it.each(['complete', 'error'] as const)('settles command hooks before the %s notification', async (terminal) => {
    let releasePost!: () => void;
    let releaseStop!: () => void;
    const postGate = new Promise<void>(resolve => { releasePost = resolve; });
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const events: string[] = [];
    const policy = await applyRuntimeSkillInvocationPolicy({
      provider: 'mock-provider',
      context: { commandInvocation: { name: 'registered', source: 'extension',
        runtimePolicy: { enforceAtRuntime: true },
        hooks: { PostToolUse: [{ command: 'post-marker' }], Stop: [{ command: 'stop-marker' }] } } },
      events: {
        beforeToolExecute: async (_tool, input) => {
          const command = String(input.command);
          events.push(command);
          await (command === 'post-marker' ? postGate : stopGate);
          return '[Blocked] test permission decision';
        },
        onComplete: () => { events.push('complete'); },
        onError: () => { events.push('error'); },
      },
    });
    policy.events?.onToolResult?.({ id: 'read-1', name: 'read', content: 'read result' });
    if (terminal === 'complete') policy.events?.onComplete?.();
    else policy.events?.onError?.(new Error('provider failed'));
    const finalization = awaitRuntimeSkillInvocationPolicy(policy);
    expect(events).toEqual(['post-marker']);
    releasePost();
    await vi.waitFor(() => expect(events).toEqual(['post-marker', 'stop-marker']));
    releaseStop();
    await finalization;
    await awaitRuntimeSkillInvocationPolicy(policy);
    expect(events).toEqual(['post-marker', 'stop-marker', terminal]);
  });

  it.each(['hook-message', 'model-preference', 'stderr'] as const)('runs Notification for %s without recursively dispatching its own output', async (source) => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-notification-hook-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'notifications.txt');
    const encodedMarker = Buffer.from(marker).toString('base64');
    const fixture = await optionsWithSkill({
      ...(source === 'model-preference' ? { model: 'sonnet' } : {
        sessionStart: nodeCommand(source === 'stderr'
          ? "process.stderr.write('Check release gate')"
          : 'process.stdout.write(JSON.stringify({message:\'Preparing review\'}))'),
      }),
      notification: nodeCommand(`require('node:fs').appendFileSync(Buffer.from('${encodedMarker}','base64').toString(),JSON.parse(process.env.KODAX_HOOK_PAYLOAD).message);process.stdout.write(JSON.stringify({message:'Notification handled'}))`),
    });
    await applyRuntimeSkillInvocationPolicy(fixture.options, 'Inspect');
    expect(await readFile(marker, 'utf8')).toBe(source === 'model-preference'
      ? "Skill model preference 'sonnet' is unsupported by 'mock-provider'; using the current model."
      : source === 'stderr' ? '[Hook SessionStart stderr] Check release gate' : 'Preparing review');
  }, 20_000);
  it('keeps plain-text startup hook output as additional context', async () => {
    const fixture = await optionsWithSkill({ sessionStart: nodeCommand("process.stdout.write('Inspect the authentication boundary.')") });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options, 'Inspect');
    expect(options.context?.promptOverlay).toContain('Inspect the authentication boundary.');
  });
  it.each([false, true])('runs the trusted Stop hook once when invocation settlement is awaited twice (fork=%s)', async (fork) => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-stop-hook-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'stopped.txt');
    const encodedMarker = Buffer.from(marker).toString('base64');
    const fixture = await optionsWithSkill({ fork, stop: nodeCommand(`require('node:fs').appendFileSync(Buffer.from('${encodedMarker}','base64').toString(),process.env.KODAX_HOOK_EVENT)`) });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options, 'Inspect');
    await Promise.all([awaitRuntimeSkillInvocationPolicy(options), awaitRuntimeSkillInvocationPolicy(options)]);
    expect(await readFile(marker, 'utf8')).toBe(fork ? 'SubagentStop' : 'Stop');
  });
  it('preserves existing context and includes both startup hook contexts with the real submitted prompt', async () => {
    const fixture = await optionsWithSkill({
      sessionStart: nodeCommand('process.stdout.write(JSON.stringify({additionalContext:\'Trusted startup instructions\'}))'),
      userPromptSubmit: nodeCommand('process.stdout.write(JSON.stringify({additional_context:JSON.parse(process.env.KODAX_HOOK_PAYLOAD).prompt}))'),
    });
    fixture.options.context!.promptOverlay = 'Existing instructions';
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options, '/transport-skill inspect current diff');
    expect(options.context?.promptOverlay).toBe('Existing instructions\n\nTrusted startup instructions\n\n/transport-skill inspect current diff');
  }, 20_000);
  it('blocks invocation admission when a trusted SessionStart hook refuses it', async () => {
    const fixture = await optionsWithSkill({ sessionStart: nodeCommand('process.stdout.write(JSON.stringify({allow:false,message:\'Not ready\'}))') });
    await expect(applyRuntimeSkillInvocationPolicy(fixture.options)).rejects.toMatchObject({
      code: 'skill_invocation_blocked', message: expect.stringContaining('Not ready'),
    });
  });
  it('blocks invocation admission when a trusted UserPromptSubmit hook refuses it', async () => {
    const fixture = await optionsWithSkill({ userPromptSubmit: nodeCommand('process.stdout.write(JSON.stringify({continue:false,message:\'Prompt refused\'}))') });
    await expect(applyRuntimeSkillInvocationPolicy(fixture.options, '/transport-skill')).rejects.toMatchObject({
      code: 'skill_invocation_blocked', message: expect.stringContaining('Prompt refused'),
    });
  });
  it('applies the trusted Skill model preference instead of caller metadata', async () => {
    const fixture = await optionsWithSkill({ model: 'review-model' });
    fixture.options.modelOverride = 'current-model';
    fixture.options.context!.skillInvocation!.model = 'untrusted-model';
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    expect(options.modelOverride).toBe('review-model');
    expect(options.context?.skillInvocation?.model).toBe('review-model');
  });
  it('rehydrates allowed-tools from the trusted runtime Skill', async () => {
    const fixture = await optionsWithSkill({ allowedTools: 'read' });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toBe(true);
    await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toContain(
      "Tool 'write' is not allowed",
    );
    expect(options.context?.skillInvocation?.runtimePolicy?.enforceAtRuntime).toBe(false);
  });

  it('runs trusted PreToolUse hooks before tool execution', async () => {
    const fixture = await optionsWithSkill({
      preToolUse: nodeCommand('process.stdout.write(JSON.stringify({allow:false}))'),
    });
    const admit = vi.fn(async () => true);
    fixture.options.events = { beforeToolExecute: admit };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
      "PreToolUse hook blocked 'read'",
    );
    await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toBe(true);
    expect(admit).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({ _frontmatterHook: true, _hookEvent: 'PreToolUse' }),
    );
  });

  it('does not bypass the selected shell sandbox when executing trusted hooks', async () => {
    const fixture = await optionsWithSkill({ preToolUse: nodeCommand('process.stdout.write(JSON.stringify({allow:true}))') });
    const prepare = vi.fn(async () => undefined);
    fixture.options.context!.shellSandbox = { prepare };
    fixture.options.context!.authorizeShellHostExecution = async () => false;
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);
    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain('PreToolUse hook blocked');
    expect(prepare).toHaveBeenCalled();
  });

  it('fails closed when an isolated PreToolUse hook has no runtime permission broker', async () => {
    const fixture = await optionsWithSkill({
      preToolUse: nodeCommand('process.stdout.write(JSON.stringify({allow:true}))'),
    });
    fixture.options.events = undefined;
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
      "PreToolUse hook blocked 'read'",
    );
  });

  it('runs trusted PostToolUse hooks after a tool result', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-hook-marker-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done')`,
      ),
    });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' });
    await awaitRuntimeSkillInvocationPolicy(options);
    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('waits for delayed PostToolUse hooks before runtime completion', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-delayed-hook-marker-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `setTimeout(()=>require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done'),80)`,
      ),
    });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' });
    await awaitRuntimeSkillInvocationPolicy(options);

    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('runs PostToolUse hooks even when the base result observer throws', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-post-hook-finally-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done')`,
      ),
    });
    fixture.options.events = {
      beforeToolExecute: async () => true,
      onToolResult: () => { throw new Error('injected result observer failure'); },
    };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    expect(() => options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' }))
      .toThrow('injected result observer failure');
    await awaitRuntimeSkillInvocationPolicy(options);
    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('diagnoses invalid allowed-tools entries while preserving fail-closed enforcement', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      const fixture = await optionsWithSkill({ allowedTools: 'read, imaginary-tool' });
      const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

      await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toBe(true);
      await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toContain('not allowed');
      expect(diagnostics).toContainEqual(expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('invalid allowed-tools'),
      }));
    } finally {
      restore();
    }
  });

  it('fails closed when a PreToolUse hook returns malformed output', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      const fixture = await optionsWithSkill({
        preToolUse: nodeCommand("process.stdout.write('not-json')"),
      });
      const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

      await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
        "PreToolUse hook blocked 'read'",
      );
      expect(diagnostics).toContainEqual(expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('invalid JSON'),
      }));
    } finally {
      restore();
    }
  });

  it('fails closed when a PreToolUse hook command exits unsuccessfully', async () => {
    const fixture = await optionsWithSkill({
      preToolUse: nodeCommand('process.exit(7)'),
    });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
      "PreToolUse hook blocked 'read'",
    );
  });

  it('treats a bound registry as authoritative when it excludes the named Skill', async () => {
    const fixture = await optionsWithSkill({});
    const restrictedRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-restricted-registry-'));
    tempDirs.push(restrictedRoot);
    const restrictedRegistry = new SkillRegistry(restrictedRoot);
    await restrictedRegistry.discover();
    fixture.options.context!.skillRegistry = restrictedRegistry;

    await expect(applyRuntimeSkillInvocationPolicy(fixture.options)).rejects.toMatchObject({
      code: 'skill_not_registered', source: 'local', stage: 'skill_load', skillName: 'transport-skill',
    });
  });

  it('fails closed when the transport names a Skill absent from trusted discovery', async () => {
    const fixture = await optionsWithSkill({});
    fixture.options.context!.skillInvocation!.name = 'untrusted-skill';

    await expect(applyRuntimeSkillInvocationPolicy(fixture.options)).rejects.toMatchObject({
      code: 'skill_not_found', source: 'local', stage: 'skill_load', skillName: 'untrusted-skill',
    });
  });
});
