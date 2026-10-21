import { describe, expect, it } from 'vitest';
import { captureGenerationResume, parseGenerationCheckpoint, rebindGenerationOptions } from './runtime-generation-recovery.js';

describe('generation recovery admission', () => {
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
});
