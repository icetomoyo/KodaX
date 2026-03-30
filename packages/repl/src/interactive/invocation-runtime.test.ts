import { describe, expect, it, vi } from 'vitest';
import { prepareInvocationExecution } from './invocation-runtime.js';

describe('prepareInvocationExecution', () => {
  it('returns manual mode when model invocation is disabled', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'zhipu-coding' },
      {
        prompt: 'Do the thing',
        source: 'skill',
        displayName: 'manual-skill',
        disableModelInvocation: true,
      },
      '/skill:manual-skill',
      vi.fn()
    );

    expect(prepared.mode).toBe('manual');
    expect(prepared.manualOutput).toContain('model invocation disabled');
  });

  it('adds hook output to the prepared prompt', async () => {
    const prepared = await prepareInvocationExecution(
      { provider: 'zhipu-coding' },
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
      { provider: 'zhipu-coding' },
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
    expect(prepared.options?.context?.rawUserInput).toBe('/skill:review-skill --focus coding');
    expect(prepared.options?.context?.skillInvocation).toEqual(
      expect.objectContaining({
        name: 'review-skill',
        expandedContent: '# Review Skill\nUse the full workflow.',
      }),
    );
  });
});
