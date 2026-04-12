import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createHookRegistry,
  getMatchingHooks,
  runHooks,
} from './registry.js';
import type { HookConfig, HookEventContext } from './types.js';
import * as executor from './executor.js';

vi.mock('./executor.js');

describe('createHookRegistry', () => {
  it('creates registry with valid config', () => {
    const config: HookConfig = {
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'echo test' },
        ],
        PostToolUse: [
          { type: 'http', url: 'http://example.com' },
        ],
      },
    };

    const registry = createHookRegistry(config);
    expect(registry.entries).toHaveLength(2);
    expect(registry.entries[0].eventType).toBe('PreToolUse');
    expect(registry.entries[1].eventType).toBe('PostToolUse');
  });

  it('filters out invalid event types', () => {
    const config = {
      hooks: {
        PreToolUse: [{ type: 'command', command: 'test' }],
        InvalidEvent: [{ type: 'command', command: 'test' }],
      },
    } as HookConfig;

    const registry = createHookRegistry(config);
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].eventType).toBe('PreToolUse');
  });

  it('filters out invalid hook types', () => {
    const config: HookConfig = {
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'valid' },
          { type: 'invalid' } as any,
        ],
      },
    };

    const registry = createHookRegistry(config);
    expect(registry.entries).toHaveLength(1);
  });

  it('creates regex matcher from matcher string', () => {
    const config: HookConfig = {
      hooks: {
        PreToolUse: [
          { type: 'command', matcher: 'bash.*', command: 'echo' },
        ],
      },
    };

    const registry = createHookRegistry(config);
    expect(registry.entries[0].matcher).toBeDefined();
    expect(registry.entries[0].matcher?.test('bash-tool')).toBe(true);
    expect(registry.entries[0].matcher?.test('python-tool')).toBe(false);
  });

  it('handles empty config', () => {
    const config: HookConfig = { hooks: {} };
    const registry = createHookRegistry(config);
    expect(registry.entries).toHaveLength(0);
  });

  it('ignores non-array hook values', () => {
    const config: HookConfig = {
      hooks: {
        PreToolUse: 'not-an-array' as any,
      },
    };

    const registry = createHookRegistry(config);
    expect(registry.entries).toHaveLength(0);
  });
});

describe('getMatchingHooks', () => {
  const registry = createHookRegistry({
    hooks: {
      PreToolUse: [
        { type: 'command', command: 'cmd1' },
        { type: 'command', matcher: 'bash.*', command: 'cmd2' },
        { type: 'command', matcher: 'python.*', command: 'cmd3' },
      ],
      PostToolUse: [
        { type: 'http', url: 'http://example.com' },
      ],
    },
  });

  it('matches all hooks for an event type when no tool name provided', () => {
    const matching = getMatchingHooks(registry, 'PreToolUse');
    expect(matching).toHaveLength(3);
  });

  it('filters hooks by matcher regex', () => {
    const matching = getMatchingHooks(registry, 'PreToolUse', 'bash-tool');
    expect(matching).toHaveLength(2); // universal hook + bash matcher
    expect(matching.every(e => !e.matcher || e.matcher.test('bash-tool'))).toBe(true);
  });

  it('returns empty array for non-existent event type', () => {
    const matching = getMatchingHooks(registry, 'SessionStart');
    expect(matching).toHaveLength(0);
  });

  it('matches hooks without matcher for any tool', () => {
    const matching = getMatchingHooks(registry, 'PreToolUse', 'any-tool-name');
    // Should include the universal hook (no matcher)
    const universal = matching.filter(e => !e.matcher);
    expect(universal.length).toBeGreaterThan(0);
  });

  it('excludes matcher hooks that do not match tool name', () => {
    const matching = getMatchingHooks(registry, 'PreToolUse', 'python-tool');
    expect(matching.every(e => !e.matcher || e.matcher.test('python-tool'))).toBe(true);
  });
});

describe('runHooks', { sequential: true }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pass when no matching hooks', async () => {
    const registry = createHookRegistry({ hooks: {} });
    const context: HookEventContext = { eventType: 'PreToolUse' };

    const result = await runHooks(registry, context);
    expect(result.action).toBe('pass');
  });

  it('first deny wins for PreToolUse', async () => {
    const registry = createHookRegistry({
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'cmd1' },
          { type: 'command', command: 'cmd2' },
        ],
      },
    });

    const mockExecutor = vi.mocked(executor.executeHook);
    mockExecutor.mockResolvedValueOnce({ action: 'allow' });
    mockExecutor.mockResolvedValueOnce({ action: 'deny', reason: 'Denied' });

    const context: HookEventContext = { eventType: 'PreToolUse' };
    const result = await runHooks(registry, context);

    expect(result.action).toBe('deny');
    expect(result.reason).toBe('Denied');
  });

  it('returns allow if no deny for PreToolUse', async () => {
    const registry = createHookRegistry({
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'cmd1' },
          { type: 'command', command: 'cmd2' },
        ],
      },
    });

    const mockExecutor = vi.mocked(executor.executeHook);
    mockExecutor.mockResolvedValueOnce({ action: 'allow' });
    mockExecutor.mockResolvedValueOnce({ action: 'pass' });

    const context: HookEventContext = { eventType: 'PreToolUse' };
    const result = await runHooks(registry, context);

    expect(result.action).toBe('allow');
  });

  it('executes all hooks for non-PreToolUse events', async () => {
    const registry = createHookRegistry({
      hooks: {
        PostToolUse: [
          { type: 'command', command: 'cmd1' },
          { type: 'command', command: 'cmd2' },
        ],
      },
    });

    const mockExecutor = vi.mocked(executor.executeHook);
    mockExecutor.mockResolvedValue({ action: 'pass' });

    const context: HookEventContext = { eventType: 'PostToolUse' };
    await runHooks(registry, context);

    expect(mockExecutor).toHaveBeenCalledTimes(2);
  });

  it('returns first non-pass result', async () => {
    const registry = createHookRegistry({
      hooks: {
        SessionEnd: [
          { type: 'command', command: 'cmd1' },
          { type: 'command', command: 'cmd2' },
          { type: 'command', command: 'cmd3' },
        ],
      },
    });

    const mockExecutor = vi.mocked(executor.executeHook);
    mockExecutor.mockResolvedValueOnce({ action: 'pass' });
    mockExecutor.mockResolvedValueOnce({ action: 'allow', reason: 'Allowed' });
    mockExecutor.mockResolvedValueOnce({ action: 'pass' });

    const context: HookEventContext = { eventType: 'SessionEnd' };
    const result = await runHooks(registry, context);

    expect(result.action).toBe('allow');
    expect(result.reason).toBe('Allowed');
  });
});
