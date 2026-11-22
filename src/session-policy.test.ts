import { describe, expect, it } from 'vitest';
import { resolveWorkMode } from '@kodax-ai/coding';

import { executionToolPolicyCeiling } from './execution-profile.js';
import type { RuntimeKodaXOptions } from './sdk-runtime.js';
import { applySessionPolicy, parseRunOptions, parseSessionPolicy } from './session-policy.js';

const tool = (name: string) => ({ name, sideEffect: 'readonly' as const, planModeAllowed: true });

describe('reading a Session policy', () => {
  it('keeps what it enforces and reads an empty policy as none', () => {
    const policy = {
      tools: ['read', 'grep', 'read'],
      budget: { maxIter: 12, maxDurationMs: 60_000 },
      agentProfile: { name: 'Clerk', instructions: 'You are the release clerk.' },
      prompt: { kodaxGuidance: 'omit', context: [{ key: 'tone', kind: 'rule', text: 'Answer in one sentence.' }] },
      interactions: 'reject',
    };
    expect(parseSessionPolicy(policy)).toEqual({ ...policy, tools: ['read', 'grep'] });
    expect(parseSessionPolicy({ interactions: 'wait' })).toEqual({ interactions: 'wait' });
    expect(parseSessionPolicy({ tools: [] })).toEqual({ tools: [] });
    expect(parseSessionPolicy(undefined)).toBeUndefined();
    expect(parseSessionPolicy({})).toBeUndefined();
    expect(parseSessionPolicy({ budget: {} })).toBeUndefined();
  });

  it.each([
    ['a policy that is not an object', ['read']],
    ['a field it does not know', { leases: [] }],
    ['a tool without a name', { tools: ['read', ' '] }],
    ['tools that are not a list', { tools: 'read' }],
    ['a token budget, which no Run enforces yet', { budget: { tokenBudget: 1000 } }],
    ['an iteration limit below one', { budget: { maxIter: 0 } }],
    ['an iteration limit that is not a whole number', { budget: { maxIter: 1.5 } }],
    ['a time limit below one millisecond', { budget: { maxDurationMs: 0 } }],
    ['a time limit no timer can hold', { budget: { maxDurationMs: 2 ** 31 } }],
    ['a persona with a verification contract', { agentProfile: { name: 'Clerk', verification: {} } }],
    ['a persona field that is not text', { agentProfile: { name: 7 } }],
    ['a malformed application prompt', { prompt: { context: [{ key: 'Tone', kind: 'rule', text: 'x' }] } }],
    ['a way to treat questions it does not know', { interactions: 'ask' }],
  ])('refuses %s', (_what, value) => {
    expect(() => parseSessionPolicy(value)).toThrow(expect.objectContaining({ code: 'invalid_params' }));
  });
});

describe('reading the options of one Run', () => {
  it('keeps limits and application prompt entries, and reads none as none', () => {
    const options = {
      budget: { maxIter: 2, maxDurationMs: 30_000 },
      prompt: { context: [{ key: 'order', kind: 'reference', text: 'Order 42 shipped on Friday.' }] },
    };
    expect(parseRunOptions(options)).toEqual(options);
    expect(parseRunOptions(undefined)).toBeUndefined();
    expect(parseRunOptions({ budget: {} })).toBeUndefined();
  });

  it.each([
    ['options that are not an object', 'fast'],
    ['tools, which only the Session fixes', { tools: ['read'] }],
    ['a persona, which only the Session fixes', { agentProfile: { name: 'Clerk' } }],
    ['whether a person is asked, which only the Session fixes', { interactions: 'reject' }],
    ['a time limit below one millisecond', { budget: { maxDurationMs: 0 } }],
    ['a malformed application prompt', { prompt: { context: [{ key: 'Tone', kind: 'rule', text: 'x' }] } }],
  ])('refuses %s', (_what, value) => {
    expect(() => parseRunOptions(value)).toThrow(expect.objectContaining({ code: 'invalid_params' }));
  });

  it('says that it is the options of a Run it refuses', () => {
    expect(() => parseRunOptions({ budget: { maxIter: 0 } })).toThrow(/^Invalid Run options: budget\.maxIter/);
    expect(() => parseSessionPolicy({ budget: { maxIter: 0 } })).toThrow(/^Invalid Session policy: budget\.maxIter/);
  });

  it('is bound before the policy of the Session, so the entries of the Session stay in front', () => {
    const tone = { key: 'tone', kind: 'rule' as const, text: 'Answer in one sentence.' };
    const order = { key: 'order', kind: 'reference' as const, text: 'Order 42 shipped on Friday.' };
    const run = applySessionPolicy({ maxIter: 30 }, parseRunOptions({ budget: { maxIter: 9, maxDurationMs: 5_000 }, prompt: { context: [order] } }));
    const bound = applySessionPolicy(run, { budget: { maxIter: 4, maxDurationMs: 60_000 }, prompt: { context: [tone] } });
    expect(bound).toMatchObject({ maxIter: 4, maxDurationMs: 5_000, context: { prompt: { context: [tone, order] } } });
  });
});

describe('binding a Run to its Session policy', () => {
  it('leaves a Run of a Session without a policy as it is', () => {
    const options: RuntimeKodaXOptions = { maxIter: 5 };
    expect(applySessionPolicy(options, undefined)).toBe(options);
  });

  it('narrows the tools to what both the Session and the Run allow', () => {
    const bound = applySessionPolicy({
      executionToolCeiling: { tools: ['read', 'bash'] },
      context: { toolVisibilityPolicy: candidate => candidate.name !== 'grep' },
    }, { tools: ['read', 'grep'] });
    const visible = bound.context!.toolVisibilityPolicy!;
    expect(['read', 'grep', 'bash', 'write'].filter(name => visible(tool(name)))).toEqual(['read']);
    expect(bound.executionToolCeiling).toEqual({ tools: ['read'] });
  });

  it('writes the tool limit so that a Run continued after a restart is still bound by it', () => {
    const bound = applySessionPolicy({}, { tools: ['read'] });
    expect(executionToolPolicyCeiling(bound.context!.toolVisibilityPolicy)).toEqual({ tools: ['read'] });
  });

  it('keeps the work mode the Run had without the policy', () => {
    const policy = { tools: ['read'], agentProfile: { name: 'Clerk' } };
    expect(resolveWorkMode(applySessionPolicy({ workMode: 'agent' }, policy))).toBe('agent');
    // This Run was in the coding mode because of what it brought itself.
    const coding = applySessionPolicy({ workMode: 'agent', context: { systemPromptOverride: 'Be brief.' } }, policy);
    expect(resolveWorkMode(coding)).toBe('coding');
  });

  it('takes the lower iteration limit', () => {
    expect(applySessionPolicy({}, { budget: { maxIter: 8 } }).maxIter).toBe(8);
    expect(applySessionPolicy({ maxIter: 3 }, { budget: { maxIter: 8 } }).maxIter).toBe(3);
    expect(applySessionPolicy({ maxIter: 30 }, { budget: { maxIter: 8 } }).maxIter).toBe(8);
  });

  it('takes the shorter time limit', () => {
    expect(applySessionPolicy({}, { budget: { maxDurationMs: 60_000 } }).maxDurationMs).toBe(60_000);
    expect(applySessionPolicy({ maxDurationMs: 5_000 }, { budget: { maxDurationMs: 60_000 } }).maxDurationMs).toBe(5_000);
    expect(applySessionPolicy({ maxDurationMs: 90_000 }, { budget: { maxDurationMs: 60_000 } }).maxDurationMs).toBe(60_000);
    expect(applySessionPolicy({ maxDurationMs: 5_000 }, { tools: ['read'] }).maxDurationMs).toBe(5_000);
  });

  it('tells a Run not to wait for a person when the Session does not', () => {
    expect(applySessionPolicy({}, { interactions: 'reject' }).interactions).toBe('reject');
    expect(applySessionPolicy({}, { interactions: 'wait' })).not.toHaveProperty('interactions');
    expect(applySessionPolicy({}, { tools: ['read'] })).not.toHaveProperty('interactions');
  });

  it('gives every Run the persona of the Session', () => {
    const bound = applySessionPolicy(
      { context: { agentProfile: { name: 'Someone else' } } },
      { agentProfile: { name: 'Clerk', instructions: 'You are the release clerk.' } },
    );
    expect(bound.context!.agentProfile).toEqual({ name: 'Clerk', instructions: 'You are the release clerk.' });
  });

  it('puts the application prompt of the Session before what the Run adds', () => {
    const tone = { key: 'tone', kind: 'rule' as const, text: 'Answer in one sentence.' };
    const order = { key: 'order', kind: 'reference' as const, text: 'Order 42 shipped on Friday.' };
    const policy = { prompt: { kodaxGuidance: 'omit' as const, context: [tone] } };

    const bound = applySessionPolicy({ context: { prompt: { kodaxGuidance: 'keep', context: [order] } } }, policy);
    expect(bound.context!.prompt).toEqual({ kodaxGuidance: 'omit', context: [tone, order] });
    // A Run that is continued already carries what the Session gave it.
    expect(applySessionPolicy(bound, policy).context!.prompt).toEqual({ kodaxGuidance: 'omit', context: [tone, order] });
    expect(applySessionPolicy({}, policy).context!.prompt).toEqual({ kodaxGuidance: 'omit', context: [tone] });
  });

  it('refuses a Run that restates an entry of the Session differently', () => {
    const policy = { prompt: { context: [{ key: 'tone', kind: 'rule' as const, text: 'Answer in one sentence.' }] } };
    expect(() => applySessionPolicy(
      { context: { prompt: { context: [{ key: 'tone', kind: 'rule', text: 'Answer at length.' }] } } }, policy,
    )).toThrow(expect.objectContaining({ code: 'invalid_params' }));
  });
});
