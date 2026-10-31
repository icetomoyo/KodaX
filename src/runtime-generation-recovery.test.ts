import { describe, expect, it } from 'vitest';
import { captureGenerationResume, parseGenerationCheckpoint, rebindGenerationOptions } from './runtime-generation-recovery.js';
import { createExecutionToolPolicy } from './execution-profile.js';
import type { KodaXToolVisibilityPolicy } from '@kodax-ai/coding/client-contract';

describe('generation recovery admission', () => {
  it.each(['agent', 'coding', 'script'] as const)('preserves %s across generation recovery without rebinding it as authority', workMode => {
    const resume = captureGenerationResume({ prompt: 'Continue', options: { workMode } });
    expect(resume.options.workMode).toBe(workMode);
    expect(resume.requiredBindings).toEqual([]);
    expect(rebindGenerationOptions(resume, undefined)).toEqual({});
  });

  it('retains the thread concurrency limit as configuration without requiring a new authority binding', () => {
    const resume = captureGenerationResume({ prompt: 'Continue', options: { maxConcurrentThreadsPerSession: 2 } });
    expect(resume.options.maxConcurrentThreadsPerSession).toBe(2);
    expect(resume.requiredBindings).toEqual([]);
    expect(rebindGenerationOptions(resume, {})).toEqual({});
  });

  it('preserves Partner mode composition while requiring a fresh tool-policy binding', () => {
    const resume = captureGenerationResume({ prompt: 'Continue', options: { workMode: 'agent', context: {
      workModePolicy: 'intersect', agentProfile: { id: 'partner' }, excludeTools: ['bash'],
      toolVisibilityPolicy: () => false,
    } } });
    expect(resume.options).toMatchObject({ workMode: 'agent', context: {
      workModePolicy: 'intersect', agentProfile: { id: 'partner' }, excludeTools: ['bash'],
    } });
    expect(resume.requiredBindings).toEqual([{ path: 'context.toolVisibilityPolicy', type: 'function' }]);
    expect(() => rebindGenerationOptions(resume, {})).toThrow('toolVisibilityPolicy');
  });

  it('retains resolved instructions but excludes authority and already executed tool invocations', () => {
    const resume = captureGenerationResume({ prompt: 'Keep the public API.', options: {
      provider: 'deepseek', model: 'small', toolInvocation: { name: 'old-command', input: {} },
      context: { gitRoot: 'C:/repo', rawUserInput: 'Keep the public API.', promptOverlay: 'Resolved skill instructions',
        excludeTools: ['bash'], systemPromptOverride: 'Never modify public exports.' },
      events: { beforeToolExecute: async () => 'custom authority' },
    } });
    expect(resume.prompt).toBe('Keep the public API.');
    expect(resume.options.context).toMatchObject({ excludeTools: ['bash'], promptOverlay: 'Resolved skill instructions' });
    expect(resume.options).not.toHaveProperty('toolInvocation');
    expect(resume.options).not.toHaveProperty('events');
    expect(resume.requiredBindings).toContainEqual({ path: 'events.beforeToolExecute', type: 'function' });
    expect(() => rebindGenerationOptions(resume, { events: {} })).toThrow(/beforeToolExecute/);
  });

  it('rejects malformed checkpoints rather than treating waiting timestamps as resumable work', () => {
    expect(parseGenerationCheckpoint({ waitingSince: 'now' })).toBeUndefined();
    expect(parseGenerationCheckpoint({ version: 1, sessionId: 's', activeEntryId: null, messagesDigest: 'bad' })).toBeUndefined();
    expect(parseGenerationCheckpoint({ version: 1, sessionId: 's', activeEntryId: 'e', messagesDigest: 'a'.repeat(64), turnId: 't' }))
      .toEqual({ version: 1, sessionId: 's', activeEntryId: 'e', messagesDigest: 'a'.repeat(64), turnId: 't' });
  });

  it('requires each original authority callback and rejects cyclic bindings', () => {
    const resume = captureGenerationResume({ prompt: 'Keep scope', options: {
      context: { assertReadablePath: () => {}, toolVisibilityPolicy: () => true },
    } });
    expect(() => rebindGenerationOptions(resume, { context: {} })).toThrow(/assertReadablePath/);
    expect(() => rebindGenerationOptions(resume, { context: { assertReadablePath: () => {} } })).toThrow(/toolVisibilityPolicy/);
    expect(rebindGenerationOptions(resume, { context: { assertReadablePath: () => {}, toolVisibilityPolicy: () => true } }).context?.assertReadablePath).toBeTypeOf('function');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => captureGenerationResume({ prompt: 'x', options: { context: circular } })).toThrow(/cyclic/i);
  });

  it.each([
    { executionToolCeiling: {}, readAllowed: true, writeAllowed: true },
    { executionToolCeiling: { tools: ['read'] }, readAllowed: true, writeAllowed: false },
    { executionToolCeiling: { tools: [] }, readAllowed: false, writeAllowed: false },
  ])('reconstructs a complete profile policy from its captured ceiling (%j)', ({ executionToolCeiling, readAllowed, writeAllowed }) => {
    let resume = captureGenerationResume({ prompt: 'Continue', options: { executionToolCeiling,
      context: { toolVisibilityPolicy: createExecutionToolPolicy(executionToolCeiling) } } });
    for (let recovery = 0; recovery < 2; recovery += 1) {
      expect(resume.requiredBindings).toEqual([{ path: 'context.toolVisibilityPolicy', type: 'execution-profile' }]);
      const rebound = rebindGenerationOptions(resume, {});
      const policy = rebound.context!.toolVisibilityPolicy!;
      expect(policy({ name: 'read', sideEffect: 'readonly', planModeAllowed: true })).toBe(readAllowed);
      expect(policy({ name: 'write', sideEffect: 'mutates-fs', planModeAllowed: false })).toBe(writeAllowed);
      resume = captureGenerationResume({ prompt: resume.prompt, options: { ...resume.options, ...rebound } });
    }
    const legacy = { ...resume, options: {}, requiredBindings: [{ path: 'context.toolVisibilityPolicy', type: 'function' }] };
    expect(() => rebindGenerationOptions(legacy, {})).toThrow('toolVisibilityPolicy');
  });

  it('keeps arbitrary Runtime and unknown previous callbacks dependent on fresh bindings', () => {
    const executionToolCeiling = { tools: ['read'] };
    for (const result of [undefined, null, 1, 'true']) {
      const previous = (() => result) as unknown as KodaXToolVisibilityPolicy;
      const policy = createExecutionToolPolicy(executionToolCeiling, previous);
      expect(policy({ name: 'read', sideEffect: 'readonly', planModeAllowed: true })).toBe(false);
    }
    for (const policy of [() => false, createExecutionToolPolicy(executionToolCeiling, () => false)]) {
      const resume = captureGenerationResume({ prompt: 'Continue', options: { executionToolCeiling,
        context: { toolVisibilityPolicy: policy } } });
      expect(resume.requiredBindings).toEqual([{ path: 'context.toolVisibilityPolicy', type: 'function' }]);
      expect(() => rebindGenerationOptions(resume, {})).toThrow('toolVisibilityPolicy');
    }
    const resume = captureGenerationResume({ prompt: 'Continue', options: { executionToolCeiling,
      context: { toolVisibilityPolicy: createExecutionToolPolicy(executionToolCeiling), assertReadablePath: () => {} } } });
    expect(() => rebindGenerationOptions(resume, {})).toThrow('assertReadablePath');
    expect(rebindGenerationOptions(resume, { context: { assertReadablePath: () => {} } }).context?.toolVisibilityPolicy)
      .toBeTypeOf('function');
  });
});
