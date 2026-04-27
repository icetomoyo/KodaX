/**
 * Unit test for coding-preset wiring.
 *
 * v0.7.23 (FEATURE_080): tested the "Option Y" path —
 *   `registerPresetDispatcher` registered a dispatcher; `Runner.run`
 *   routed to it via the registry.
 *
 * v0.7.29 (FEATURE_100): Option Y deleted per ADR-020. The substrate
 *   executor is now attached directly to the Agent declaration via
 *   `Agent.substrateExecutor`; `Runner.run` consults that field
 *   *before* the registry. This test reflects the new shape — a mock
 *   executor is attached to a custom Agent (NOT registered globally),
 *   exercising the declaration-borne dispatch path.
 */

import { describe, expect, it, vi } from 'vitest';

import { Runner, createAgent, type PresetDispatcher } from '@kodax/core';
import { DEFAULT_CODING_AGENT_NAME, createDefaultCodingAgent } from './coding-preset.js';

describe('coding-preset', () => {
  it('createDefaultCodingAgent returns an agent with the stable dispatch name', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    expect(typeof agent.instructions).toBe('string');
  });

  it('createDefaultCodingAgent attaches a substrate executor closure on the declaration', () => {
    const agent = createDefaultCodingAgent();
    expect(typeof agent.substrateExecutor).toBe('function');
  });

  it('Runner.run delegates to Agent.substrateExecutor (declaration-borne, no registry)', async () => {
    const mock: PresetDispatcher = vi.fn(async () => ({
      output: 'mocked coding output',
      messages: [{ role: 'assistant' as const, content: 'mocked coding output' }],
      sessionId: 'mock-session',
    }));
    // Build a custom agent with our mock executor — proves Runner.run
    // dispatches off the declaration field, not a global registry.
    const customAgent = createAgent({
      name: 'test/coding/declaration-borne',
      instructions: 'test',
      substrateExecutor: mock,
    });
    const result = await Runner.run(customAgent, 'implement thing', {
      presetOptions: { provider: 'test-provider' },
      tracer: null,
    });
    expect(result.output).toBe('mocked coding output');
    expect(result.sessionId).toBe('mock-session');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      customAgent,
      'implement thing',
      { presetOptions: { provider: 'test-provider' }, tracer: null },
    );
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
    // Overrides MUST NOT overwrite the substrate executor closure.
    expect(typeof agent.substrateExecutor).toBe('function');
  });
});
