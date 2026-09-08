import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareInvocationExecution } from './invocation-runtime.js';

describe('prepareInvocationExecution', () => {
  it('leaves all Skill execution to the Host when the client plane owns the round', async () => {
    const beforeToolExecute = vi.fn(async () => false);
    const prepared = await prepareInvocationExecution(
      { provider: 'zhipu-coding', events: { beforeToolExecute } },
      { source: 'skill', displayName: 'host-skill', prompt: 'expanded', context: 'fork',
        hooks: { SessionStart: [{ command: 'echo start' }], Stop: [{ command: 'echo stop' }] } },
      '/host-skill original request', vi.fn(), true,
    );
    expect(prepared.prompt).toBe('/host-skill original request');
    await prepared.finalize();
    expect(beforeToolExecute).not.toHaveBeenCalled();
  });
  it('executes an explicit skill invocation when model invocation is disabled', async () => {
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: { beforeToolExecute: async () => true },
      },
      {
        prompt: 'Do the thing',
        source: 'skill',
        displayName: 'manual-skill',
        disableModelInvocation: true,
      },
      '/skill:manual-skill',
      vi.fn()
    );

    expect(prepared.mode).toBe('inline');
    expect(prepared.prompt).toContain('Do the thing');
    expect(prepared.prompt).toContain('/skill:manual-skill');
  });

  it('adds hook output to the prepared prompt', async () => {
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: { beforeToolExecute: async () => true },
      },
      {
        prompt: 'Base prompt',
        source: 'skill',
        displayName: 'hooked-skill',
        hooks: {
          UserPromptSubmit: [{ command: 'echo prompt-hook' }],
        },
      },
      '/skill:hooked-skill',
      vi.fn()
    );

    expect(prepared.mode).toBe('inline');
    expect(prepared.prompt).toContain('prompt-hook');
    expect(prepared.prompt).toContain('Base prompt');
    expect(prepared.options?.context?.promptOverlay).toContain('prompt-hook');
    expect(prepared.options?.context?.promptOverlay).toContain('Base prompt');
  });

  it('blocks shell hooks when the current permission policy denies bash execution', async () => {
    const emit = vi.fn();
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: {
          beforeToolExecute: async (tool) => tool !== 'bash',
        },
      },
      {
        prompt: 'Base prompt',
        source: 'skill',
        displayName: 'hooked-skill',
        hooks: {
          UserPromptSubmit: [{ command: 'echo prompt-hook' }],
        },
      },
      '/skill:hooked-skill',
      emit
    );

    expect(prepared.mode).toBe('manual');
    expect(prepared.manualOutput).toContain('stopped by a UserPromptSubmit hook');
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('blocked by the current permission policy'));
  });

  it('blocks shell hooks when allowed-tools does not permit bash', async () => {
    const emit = vi.fn();
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: {
          beforeToolExecute: async () => true,
        },
      },
      {
        prompt: 'Base prompt',
        source: 'skill',
        displayName: 'hooked-skill',
        allowedTools: 'Read, Grep',
        hooks: {
          UserPromptSubmit: [{ command: 'echo prompt-hook' }],
        },
      },
      '/skill:hooked-skill',
      emit
    );

    expect(prepared.mode).toBe('manual');
    expect(prepared.manualOutput).toContain('stopped by a UserPromptSubmit hook');
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('blocked by allowed-tools policy'));
  });

  it('blocks tools outside the allowed-tools list', async () => {
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: {
          beforeToolExecute: async () => true,
        },
      },
      {
        prompt: 'Use only read tools',
        source: 'prompt',
        displayName: 'read-only-command',
        allowedTools: 'Read, Grep',
      },
      '/read-only-command',
      vi.fn()
    );

    expect(prepared.mode).toBe('inline');
    expect(prepared.options).toBeDefined();
    const allowRead = await prepared.options!.events!.beforeToolExecute!('read', {});
    const allowWrite = await prepared.options!.events!.beforeToolExecute!('write', {});

    expect(allowRead).toBe(true);
    expect(allowWrite).toBe(false);
  });

  it.each([
    ['malformed output', "process.stdout.write('not-json')"],
    ['an unsuccessful command', 'process.exit(7)'],
  ])('fails closed when a PreToolUse hook has %s', async (_label, script) => {
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: { beforeToolExecute: async () => true },
      },
      {
        prompt: 'Guard each read',
        source: 'prompt',
        displayName: 'guarded-command',
        hooks: {
          PreToolUse: [{
            matcher: 'read',
            command: `"${process.execPath}" -e "${script}"`,
          }],
        },
      },
      '/guarded-command',
      vi.fn(),
    );

    await expect(prepared.options!.events!.beforeToolExecute!('read', {})).resolves.toBe(false);
  });

  it('fails closed when a host lifecycle hook has no permission broker', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'zhipu-coding' },
      {
        prompt: 'Base prompt',
        source: 'skill',
        displayName: 'hooked-skill',
        hooks: {
          UserPromptSubmit: [{ command: 'echo must-not-run' }],
        },
      },
      '/skill:hooked-skill',
      vi.fn(),
    );

    expect(prepared.mode).toBe('manual');
    expect(prepared.manualOutput).toContain('stopped by a UserPromptSubmit hook');
  });

  it('treats a permission broker string result as a hook denial', async () => {
    const emit = vi.fn();
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: { beforeToolExecute: async () => '[Denied] plan mode' },
      },
      {
        prompt: 'Base prompt',
        source: 'skill',
        displayName: 'hooked-skill',
        hooks: {
          UserPromptSubmit: [{ command: 'echo must-not-run' }],
        },
      },
      '/skill:hooked-skill',
      emit,
    );

    expect(prepared.mode).toBe('manual');
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('[Denied] plan mode'));
  });

  it('runs host lifecycle hooks from the invocation execution directory', async () => {
    const executionCwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-host-hook-cwd-'));
    try {
      const prepared = await prepareInvocationExecution(
        {
          provider: 'zhipu-coding',
          context: { executionCwd },
          events: { beforeToolExecute: async () => true },
        },
        {
          prompt: 'Base prompt',
          source: 'skill',
          displayName: 'hooked-skill',
          hooks: {
            UserPromptSubmit: [{
              command: `"${process.execPath}" -e "process.stdout.write(process.cwd())"`,
            }],
          },
        },
        '/skill:hooked-skill',
        vi.fn(),
      );

      expect(prepared.prompt).toContain(executionCwd);
    } finally {
      await rm(executionCwd, { recursive: true, force: true });
    }
  });

  it('serializes Skill tool policy for daemon and worker reconstruction', async () => {
    const onToolResult = vi.fn();
    const prepared = await prepareInvocationExecution(
      { provider: 'zhipu-coding', events: { onToolResult } },
      {
        prompt: 'Use only read tools',
        source: 'skill',
        displayName: 'transport-skill',
        path: 'C:/skills/transport-skill/SKILL.md',
        allowedTools: 'Read',
        hooks: {
          PreToolUse: [{ matcher: 'read', command: 'echo pre' }],
          PostToolUse: [{ matcher: 'read', command: 'echo post' }],
        },
        skillInvocation: {
          name: 'transport-skill',
          path: 'C:/skills/transport-skill/SKILL.md',
          expandedContent: '<skill name="transport-skill">test</skill>',
        },
      },
      '/transport-skill',
      vi.fn(),
    );

    expect(prepared.options?.context?.skillInvocation?.runtimePolicy).toEqual({
      enforceAtRuntime: true,
    });
    expect(JSON.stringify(prepared.options?.context?.skillInvocation?.runtimePolicy))
      .not.toContain('echo');
    expect(prepared.options?.events?.onToolResult).toBe(onToolResult);
  });

  it('fails closed when allowed-tools contains only invalid entries', async () => {
    const emit = vi.fn();
    const prepared = await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: {
          beforeToolExecute: async () => true,
        },
      },
      {
        prompt: 'Use only approved tools',
        source: 'prompt',
        displayName: 'strict-command',
        allowedTools: 'Bashh(git:*)',
      },
      '/strict-command',
      emit
    );

    expect(prepared.mode).toBe('inline');
    expect(await prepared.options!.events!.beforeToolExecute!('read', {})).toBe(false);
    expect(await prepared.options!.events!.beforeToolExecute!('bash', { command: 'git status' })).toBe(false);
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('invalid allowed-tools entries'));
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('all tool execution will be blocked'));
  });

  it('dispatches Notification hooks for runtime messages without recursion', async () => {
    const emit = vi.fn();
    await prepareInvocationExecution(
      {
        provider: 'zhipu-coding',
        events: { beforeToolExecute: async () => true },
      },
      {
        prompt: 'Use sonnet',
        source: 'skill',
        displayName: 'notify-skill',
        model: 'sonnet',
        hooks: {
          Notification: [{ matcher: '*Model preference*', command: 'echo notification-received' }],
        },
      },
      '/skill:notify-skill',
      emit
    );

    expect(emit).toHaveBeenCalledWith(expect.stringContaining("Model preference 'sonnet' is not supported"));
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('[Hook Notification] notification-received'));
  });

  it('resolves anthropic model preferences into a per-run override', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic' },
      {
        prompt: 'Use sonnet',
        source: 'skill',
        displayName: 'sonnet-skill',
        model: 'sonnet',
      },
      '/skill:sonnet-skill',
      vi.fn()
    );

    expect(prepared.options?.modelOverride).toBe('claude-sonnet-4-6');
  });

  it('normalizes a legacy AMAW turn override to AMA without touching the session mode', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic', agentMode: 'ama' },
      {
        prompt: 'Author and run a workflow',
        source: 'prompt',
        displayName: 'workflow create',
        agentModeOverride: 'amaw',
      },
      '/workflow create compare repos',
      vi.fn()
    );

    expect(prepared.options?.agentMode).toBe('ama');
  });

  it('keeps the Workflow runs directory while normalizing a legacy AMAW override', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic', agentMode: 'ama', workflowRunsBaseDir: '/tmp/wf-runs' },
      {
        prompt: 'Author and run a workflow',
        source: 'prompt',
        displayName: 'workflow create',
        agentModeOverride: 'amaw',
      },
      '/workflow review since v0.7.57',
      vi.fn()
    );

    expect(prepared.options?.agentMode).toBe('ama');
    expect(prepared.options?.workflowRunsBaseDir).toBe('/tmp/wf-runs');
  });

  it('leaves agentMode untouched when no agentModeOverride is set', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic', agentMode: 'ama' },
      {
        prompt: 'do a thing',
        source: 'prompt',
        displayName: 'plain',
      },
      'do a thing',
      vi.fn()
    );

    expect(prepared.options?.agentMode).toBe('ama');
  });

  it('passes raw user input and skill invocation metadata into the prepared context', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic', context: { promptOverlay: '[base]' } },
      {
        prompt: 'Expanded skill body',
        source: 'skill',
        displayName: 'review-skill',
        skillInvocation: {
          name: 'review-skill',
          path: '/tmp/review-skill/SKILL.md',
          description: 'Review the current repository changes.',
          arguments: '--focus coding',
          allowedTools: 'Read, Grep, Bash(git status)',
          context: 'fork',
          agent: 'reviewer',
          argumentHint: '--focus <area>',
          model: 'sonnet',
          hookEvents: ['UserPromptSubmit'],
          expandedContent: '# Review Skill\nUse the full workflow.',
        },
      },
      '/skill:review-skill --focus coding',
      vi.fn(),
    );

    expect(prepared.mode).toBe('inline');
    expect(prepared.prompt).not.toContain('Expanded skill body');
    expect(prepared.prompt).not.toContain('/skill:review-skill');
    expect(prepared.prompt).toContain('the active Skill "review-skill" --focus coding');
    expect(prepared.options?.context?.rawUserInput).toBe(
      '/skill:review-skill --focus coding',
    );
    expect(prepared.options?.context?.promptOverlay).toBe('[base]');
    expect(prepared.options?.context?.promptOverlay).not.toContain('# Review Skill');
    expect(prepared.options?.context?.skillInvocation).toEqual(
      expect.objectContaining({
        name: 'review-skill',
        expandedContent: '# Review Skill\nUse the full workflow.',
      }),
    );
  });
});
