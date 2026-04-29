/**
 * FEATURE_089 Phase 3.4 — Constructed Agent Resolver tests.
 *
 * Verifies the registry-side contract:
 *   - register / resolve / list / unregister roundtrip
 *   - Tool refs resolve through TOOL_REGISTRY (builtin tools available)
 *   - Handoff target refs resolve to other constructed agents when
 *     activated; stub Agent when target hasn't been activated yet
 *   - Re-activation of the same name+version is idempotent
 *   - Revoking an agent (the unregister callback) clears the entry
 *     unless a different version has since taken its place
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetAgentResolverForTesting,
  listConstructedAgents,
  registerConstructedAgent,
  resolveConstructedAgent,
} from './agent-resolver.js';
import type { AgentArtifact } from './types.js';

function buildAgentArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'echo-agent',
    version: overrides.version ?? '1.0.0',
    content: overrides.content ?? {
      instructions: 'Echo every user message back as the assistant reply.',
      tools: [{ ref: 'builtin:read' }],
      reasoning: { default: 'quick' },
    },
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now(),
    testedAt: overrides.testedAt ?? Date.now(),
    activatedAt: overrides.activatedAt ?? Date.now(),
  };
}

beforeEach(() => {
  _resetAgentResolverForTesting();
});
afterEach(() => {
  _resetAgentResolverForTesting();
});

describe('registerConstructedAgent / resolveConstructedAgent', () => {
  it('returns undefined before any agent is registered', () => {
    expect(resolveConstructedAgent('any')).toBeUndefined();
  });

  it('round-trips a minimal agent — name + instructions', () => {
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'minimal',
        content: { instructions: 'hi' },
      }),
    );
    const agent = resolveConstructedAgent('minimal');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('minimal');
    expect(agent?.instructions).toBe('hi');
  });

  it('lifts a builtin tool ref to a structural AgentTool entry', () => {
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'with-builtin-read',
        content: {
          instructions: 'read files',
          tools: [{ ref: 'builtin:read' }],
        },
      }),
    );
    const agent = resolveConstructedAgent('with-builtin-read');
    expect(agent?.tools).toHaveLength(1);
    expect((agent?.tools?.[0] as { name?: string }).name).toBe('read');
  });

  it('skips unresolved tool refs silently (LLM-authoring footgun, not security bypass)', () => {
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'unresolved',
        content: {
          instructions: 'i',
          tools: [{ ref: 'builtin:read' }, { ref: 'builtin:nonexistent-tool' }],
        },
      }),
    );
    const agent = resolveConstructedAgent('unresolved');
    expect(agent?.tools).toHaveLength(1);
    expect((agent?.tools?.[0] as { name?: string }).name).toBe('read');
  });

  it('lifts handoff target refs to live activated agents when present', () => {
    // Register the target FIRST so the resolver wires the live Agent.
    registerConstructedAgent(
      buildAgentArtifact({ name: 'verifier', content: { instructions: 'verify' } }),
    );
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'planner',
        content: {
          instructions: 'plan',
          handoffs: [{ target: { ref: 'verifier' }, kind: 'continuation' }],
        },
      }),
    );
    const planner = resolveConstructedAgent('planner');
    expect(planner?.handoffs).toHaveLength(1);
    expect(planner?.handoffs?.[0]?.target.name).toBe('verifier');
    // Live registration: the target Agent's `instructions` is the real one.
    expect(planner?.handoffs?.[0]?.target.instructions).toBe('verify');
  });

  it('falls back to a stub Agent for unresolved handoff targets (admission already verified the DAG)', () => {
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'planner-no-target',
        content: {
          instructions: 'plan',
          handoffs: [{ target: { ref: 'builtin:future-evaluator' }, kind: 'continuation' }],
        },
      }),
    );
    const planner = resolveConstructedAgent('planner-no-target');
    expect(planner?.handoffs?.[0]?.target.name).toBe('future-evaluator');
    expect(planner?.handoffs?.[0]?.target.instructions).toBe('');
  });

  it('passes through reasoning / model / provider fields', () => {
    registerConstructedAgent(
      buildAgentArtifact({
        name: 'rich',
        content: {
          instructions: 'i',
          reasoning: { default: 'balanced', max: 'deep' },
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
        },
      }),
    );
    const agent = resolveConstructedAgent('rich');
    expect(agent?.reasoning?.default).toBe('balanced');
    expect(agent?.model).toBe('claude-sonnet-4-6');
    expect(agent?.provider).toBe('anthropic');
  });
});

describe('listConstructedAgents', () => {
  it('returns an empty list initially', () => {
    expect(listConstructedAgents()).toEqual([]);
  });

  it('returns all currently-registered agents', () => {
    registerConstructedAgent(buildAgentArtifact({ name: 'a' }));
    registerConstructedAgent(buildAgentArtifact({ name: 'b' }));
    const names = listConstructedAgents().map((a) => a.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('unregister callback', () => {
  it('removes the agent when invoked', () => {
    const unregister = registerConstructedAgent(
      buildAgentArtifact({ name: 'transient', version: '1.0.0' }),
    );
    expect(resolveConstructedAgent('transient')).toBeDefined();
    unregister();
    expect(resolveConstructedAgent('transient')).toBeUndefined();
  });

  it('is a no-op when a different version has since taken the slot', () => {
    const unregisterV1 = registerConstructedAgent(
      buildAgentArtifact({ name: 'replaced', version: '1.0.0' }),
    );
    // Activate v2 — same name, replaces v1.
    registerConstructedAgent(
      buildAgentArtifact({ name: 'replaced', version: '2.0.0' }),
    );
    // Calling the stale v1 callback should NOT remove v2.
    unregisterV1();
    const after = resolveConstructedAgent('replaced');
    expect(after).toBeDefined();
  });
});
