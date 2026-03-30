import { describe, expect, it } from 'vitest';
import {
  evaluateSessionTransitionPolicy,
  formatSessionTransitionGuardMessage,
} from './session-guardrails.js';

describe('session transition guardrails', () => {
  it('blocks resume-style transitions on lossy bridge providers', () => {
    const decision = evaluateSessionTransitionPolicy({
      provider: 'gemini-cli',
      model: undefined,
    });

    expect(decision?.status).toBe('block');
    expect(decision?.issues.map((issue) => issue.code)).toContain('long-running-blocked');
  });

  it('formats a clear next step for blocked transitions', () => {
    const decision = evaluateSessionTransitionPolicy({
      provider: 'gemini-cli',
      model: undefined,
    });

    expect(decision).not.toBeNull();
    const lines = formatSessionTransitionGuardMessage('Resuming a saved session', decision!);
    expect(lines.join('\n')).toContain('Resuming a saved session');
    expect(lines.join('\n')).toContain('Switch to a provider with durable full-history session semantics');
  });

  it('allows transitions on providers with durable session semantics', () => {
    const decision = evaluateSessionTransitionPolicy({
      provider: 'openai',
      model: 'gpt-5.4',
    });

    expect(decision?.status).toBe('allow');
  });
});
