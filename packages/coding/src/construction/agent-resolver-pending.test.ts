/**
 * FEATURE_090 (v0.7.32) — Constructed Agent Resolver pending-swap tests.
 *
 * Covers the new `deferred: true` registration path used by the
 * self-modify activate flow:
 *
 *   - Deferred registration does NOT update `resolveConstructedAgent`
 *     output; the resolver keeps returning the prior active version.
 *   - `hasPendingSwap` reports the pending state correctly.
 *   - `drainPendingSwaps` promotes pending → active atomically and
 *     returns the names drained; subsequent resolves see the new
 *     version.
 *   - Revoke (unregister callback) of a pending entry removes it from
 *     pending without touching the active version.
 *   - Revoke of a drained entry behaves like the regular path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetAgentResolverForTesting,
  drainPendingSwaps,
  hasPendingSwap,
  listConstructedAgents,
  registerConstructedAgent,
  resolveConstructedAgent,
} from './agent-resolver.js';
import type { AgentArtifact } from './types.js';

function buildAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'alpha',
    version: overrides.version ?? '1.0.0',
    content: overrides.content ?? { instructions: 'You are alpha.' },
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

describe('deferred registration', () => {
  it('does not appear in resolveConstructedAgent until drained', () => {
    registerConstructedAgent(buildAgent({ name: 'alpha', version: '1.0.0' }));
    registerConstructedAgent(
      buildAgent({
        name: 'alpha',
        version: '1.1.0',
        content: { instructions: 'You are alpha v1.1.' },
      }),
      {},
      { deferred: true },
    );

    // Resolver still returns the prior active version.
    const before = resolveConstructedAgent('alpha');
    expect(before?.instructions).toBe('You are alpha.');

    expect(hasPendingSwap('alpha')).toBe(true);
    // listConstructedAgents reflects the active registry only.
    expect(listConstructedAgents()).toHaveLength(1);
    expect(listConstructedAgents()[0]!.instructions).toBe('You are alpha.');
  });

  it('drainPendingSwaps promotes the pending entry into active', () => {
    registerConstructedAgent(buildAgent({ name: 'alpha', version: '1.0.0' }));
    registerConstructedAgent(
      buildAgent({
        name: 'alpha',
        version: '1.1.0',
        content: { instructions: 'You are alpha v1.1.' },
      }),
      {},
      { deferred: true },
    );

    const drained = drainPendingSwaps();
    expect(drained).toEqual(['alpha']);
    expect(hasPendingSwap('alpha')).toBe(false);
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha v1.1.');
  });

  it('drainPendingSwaps returns an empty array when nothing is pending', () => {
    registerConstructedAgent(buildAgent({ name: 'alpha', version: '1.0.0' }));
    expect(drainPendingSwaps()).toEqual([]);
  });

  it('drains multiple pending entries in one call', () => {
    registerConstructedAgent(
      buildAgent({ name: 'alpha', version: '1.1.0' }),
      {},
      { deferred: true },
    );
    registerConstructedAgent(
      buildAgent({ name: 'beta', version: '0.2.0' }),
      {},
      { deferred: true },
    );

    const drained = drainPendingSwaps();
    expect([...drained].sort()).toEqual(['alpha', 'beta']);
    expect(hasPendingSwap('alpha')).toBe(false);
    expect(hasPendingSwap('beta')).toBe(false);
    expect(resolveConstructedAgent('alpha')).toBeDefined();
    expect(resolveConstructedAgent('beta')).toBeDefined();
  });
});

describe('unregister callback semantics', () => {
  it('revoking a pending entry removes it from pending without touching active', () => {
    registerConstructedAgent(buildAgent({ name: 'alpha', version: '1.0.0' }));
    const unregister = registerConstructedAgent(
      buildAgent({
        name: 'alpha',
        version: '1.1.0',
        content: { instructions: 'You are alpha v1.1.' },
      }),
      {},
      { deferred: true },
    );

    unregister();

    expect(hasPendingSwap('alpha')).toBe(false);
    // Active prior version is untouched.
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha.');
  });

  it('revoking a drained entry removes it from active (post-drain behaviour)', () => {
    const unregisterV11 = registerConstructedAgent(
      buildAgent({ name: 'alpha', version: '1.1.0' }),
      {},
      { deferred: true },
    );
    drainPendingSwaps();
    expect(resolveConstructedAgent('alpha')).toBeDefined();

    unregisterV11();
    expect(resolveConstructedAgent('alpha')).toBeUndefined();
  });

  it('stale unregister (drain replaced the entry with a different version) is a no-op', () => {
    const unregisterV1 = registerConstructedAgent(
      buildAgent({ name: 'alpha', version: '1.0.0' }),
    );
    registerConstructedAgent(
      buildAgent({
        name: 'alpha',
        version: '1.1.0',
        content: { instructions: 'You are alpha v1.1.' },
      }),
      {},
      { deferred: true },
    );
    drainPendingSwaps();
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha v1.1.');

    // unregisterV1 captured artifact v1.0.0; AGENT_REGISTRY now holds v1.1.0.
    // Calling the stale callback must not delete the v1.1 entry.
    unregisterV1();
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha v1.1.');
  });
});

describe('_resetAgentResolverForTesting', () => {
  it('clears both active and pending registries', () => {
    registerConstructedAgent(buildAgent({ name: 'alpha', version: '1.0.0' }));
    registerConstructedAgent(
      buildAgent({ name: 'alpha', version: '1.1.0' }),
      {},
      { deferred: true },
    );

    _resetAgentResolverForTesting();

    expect(resolveConstructedAgent('alpha')).toBeUndefined();
    expect(hasPendingSwap('alpha')).toBe(false);
    expect(drainPendingSwaps()).toEqual([]);
  });
});
