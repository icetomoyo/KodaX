/**
 * Unit test for coding-preset wiring (FEATURE_080 v0.7.23).
 *
 * Scope: verifies the Option-Y plumbing — importing `coding-preset.ts`
 * registers a dispatcher for the default coding agent name, and
 * `Runner.run` routes to that dispatcher. The real dispatcher invokes
 * `runKodaX` which requires a configured provider; the test overrides it
 * with a mock to keep this isolated from network / provider state.
 */

import { describe, expect, it, vi } from 'vitest';

import { Runner, registerPresetDispatcher, type PresetDispatcher } from './runner.js';
import { DEFAULT_CODING_AGENT_NAME, createDefaultCodingAgent } from './coding-preset.js';

describe('coding-preset', () => {
  it('createDefaultCodingAgent returns an agent with the stable dispatch name', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    expect(typeof agent.instructions).toBe('string');
  });

  it('Runner.run dispatches to the registered default coding dispatcher', async () => {
    const mock: PresetDispatcher = vi.fn(async () => ({
      output: 'mocked coding output',
      messages: [{ role: 'assistant' as const, content: 'mocked coding output' }],
      sessionId: 'mock-session',
    }));
    const unregister = registerPresetDispatcher(DEFAULT_CODING_AGENT_NAME, mock);
    try {
      const agent = createDefaultCodingAgent();
      const result = await Runner.run(agent, 'implement thing', {
        presetOptions: { provider: 'test-provider' },
      });
      expect(result.output).toBe('mocked coding output');
      expect(result.sessionId).toBe('mock-session');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(
        agent,
        'implement thing',
        { presetOptions: { provider: 'test-provider' } },
      );
    } finally {
      unregister();
    }
  });

  it('createDefaultCodingAgent accepts overrides for declarative fields', () => {
    const agent = createDefaultCodingAgent({
      reasoning: { default: 'deep' },
      guardrails: [{ kind: 'input', name: 'safety' }],
    });
    expect(agent.reasoning?.default).toBe('deep');
    expect(agent.guardrails).toHaveLength(1);
    expect(agent.guardrails?.[0]).toEqual({ kind: 'input', name: 'safety' });
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
  });
});
